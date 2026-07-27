/**
 * Campaign send pre-flight — consolidates the four-way-duplicated check
 * block that pre-deepening lived in `schedule`, `scheduleForOrganization`,
 * `sendNow`, and `sendNowForOrganization`. The lifecycle reducer trusts
 * its input; callers run this helper *before* `lifecycle.transition`.
 *
 * See docs/adr/0017-campaign-lifecycle-modules.md §Pre-flight helper.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { api } from '../_generated/api';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { isDeliveryConfigured } from '../lib/sendProviders/capability';
import { isCampaignSenderAllowed, senderNotAllowedMessage } from './senders';
import { assessCampaignCapacity } from './capacityPreflight';
import { MAX_PLAN_DAYS, type CampaignCapacitySchedule } from './capacityPlan';

export type PreflightResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| 'not_found'
				| 'no_template'
				| 'no_audience'
				| 'no_from_email'
				| 'no_delivery_provider'
				| 'domain_not_verified'
				| 'sender_not_allowed'
				| 'sending_not_allowed'
				| 'scheduled_in_past'
				| 'exceeds_sending_capacity';
			message: string;
			/** Present only on `exceeds_sending_capacity`. */
			capacityPlan?: CampaignCapacitySchedule;
	  };

/** The discriminant a failed pre-flight carries, for clients that branch on it. */
export type PreflightFailureReason = Extract<PreflightResult, { ok: false }>['reason'];

/**
 * Structured error payload for a failed pre-flight. `capacityPlan` is what
 * turns "too big" from prose into an offer: the client can render "send over N
 * days" straight from the refusal instead of re-deriving it. `reason` keeps its
 * union type — widening it to `string` would throw away the discriminant the
 * client needs to branch on.
 */
export function preflightErrorData(result: Extract<PreflightResult, { ok: false }>): {
	reason: PreflightFailureReason;
	capacityPlan?: CampaignCapacitySchedule;
} {
	return {
		reason: result.reason,
		...(result.capacityPlan ? { capacityPlan: result.capacityPlan } : {}),
	};
}

export interface PreflightOptions {
	/**
	 * If set, enables the future-date check (`scheduled_in_past`). Omit
	 * for `sendNow` paths that aren't tied to a future timestamp.
	 */
	scheduledAt?: number;
	/**
	 * Override the current time — used by tests. Defaults to `Date.now()`.
	 */
	now?: number;
	/**
	 * Run the BINDING capacity gate (default `true`).
	 *
	 * The gate is a pre-flight-TIME decision: it exists so the operator is
	 * offered a multi-day schedule instead of starting a campaign whose tail
	 * will silently expire in the MTA queue. The fire-time re-validation
	 * (`validateReadyToSendQuery`) has no operator in the loop — a failure there
	 * becomes `{ skipped: true }` and leaves the campaign `scheduled` for the
	 * per-minute cron to re-skip forever, trading "the tail silently expires"
	 * for "the campaign silently never starts". That path passes `false`; every
	 * shipped fire-time check still runs.
	 */
	checkCapacity?: boolean;
}

/**
 * One sentence describing a multi-day capacity schedule. All three refusal
 * messages open the same way; only the tail differs, and each tail says exactly
 * as much as the plan actually knows (D14 — say the quiet part):
 *
 *  - `truncated` — the enumeration stopped at `MAX_PLAN_DAYS` with recipients
 *    still unscheduled, so the real finish is later than any number the plan
 *    carries and `days` must NOT be quoted as a finish date.
 *  - `audienceUnderCounted` — the enumeration completed, but of an audience we
 *    only know a lower bound for, so `days` is a floor: "at least N days".
 *  - neither — `days` is the projected finish.
 */
export function describeCapacitySchedule(schedule: CampaignCapacitySchedule): string {
	const opening =
		'This campaign is larger than your sending capacity allows in one go. At your ' +
		'current warm-up capacity ';
	if (schedule.truncated) {
		return (
			`${opening}it would take more than ${MAX_PLAN_DAYS} days to reach everyone — ` +
			`send it in stages, or reduce the audience.`
		);
	}
	const dayWord = schedule.days === 1 ? 'day' : 'days';
	if (schedule.audienceUnderCounted) {
		return (
			`${opening}it takes at least ${schedule.days} ${dayWord} to reach everyone, ` +
			`so send it over several days instead.`
		);
	}
	return (
		`${opening}it takes about ${schedule.days} ${dayWord} to reach everyone, ` +
		`so send it over ${schedule.days} ${dayWord} instead.`
	);
}

type Ctx = MutationCtx | QueryCtx;

/**
 * Validate that a campaign is ready to be scheduled or sent. The reducer
 * inside `lifecycle.transition` assumes pre-flight passed; callers must
 * gate their `to: 'scheduled' | 'sending'` calls on the result.
 *
 * The order of checks mirrors the pre-deepening open-coded sequence so
 * callers see the same first-failure surface.
 */
export async function validateReadyToSend(
	ctx: Ctx,
	campaign: Doc<'campaigns'>,
	options: PreflightOptions = {}
): Promise<PreflightResult> {
	if (!campaign.emailTemplateId) {
		return {
			ok: false,
			reason: 'no_template',
			message: 'Campaign must have an email template selected',
		};
	}

	if (!campaign.audience) {
		return {
			ok: false,
			reason: 'no_audience',
			message: 'Campaign must have an audience configured',
		};
	}

	if (!campaign.fromEmail) {
		return {
			ok: false,
			reason: 'no_from_email',
			message: 'Campaign must have a from email address',
		};
	}

	const settings = await ctx.db.query('instanceSettings').first();
	const status = settings?.abuseStatus;
	if (status === 'suspended') {
		return {
			ok: false,
			reason: 'sending_not_allowed',
			message:
				'Your account has been suspended due to policy violations. Please contact support for assistance.',
		};
	}
	if (status === 'banned') {
		return {
			ok: false,
			reason: 'sending_not_allowed',
			message:
				'Your account has been permanently disabled. Please contact support for more information.',
		};
	}

	// A delivery provider must actually be configured before the domain check —
	// bulk campaigns dispatch through the composed provider abstraction,
	// never through a user's external IMAP mailbox. Without one, refuse here so
	// zero `emailSends` rows are written instead of marching every recipient to
	// `failed` against a provider that was never set up.
	if (!(await isDeliveryConfigured(ctx, 'campaign'))) {
		return {
			ok: false,
			reason: 'no_delivery_provider',
			message:
				'Cannot send campaign: no email delivery provider is configured. Set a delivery provider (EMAIL_PROVIDER + credentials, or a provider route) in Settings. A connected external mailbox does not provide bulk delivery.',
		};
	}

	const domainStatus = await ctx.runQuery(api.domains.domains.getEmailDomainVerificationStatus, {
		email: campaign.fromEmail,
	});

	if (!domainStatus.verified) {
		return {
			ok: false,
			reason: 'domain_not_verified',
			message:
				domainStatus.error ??
				`Cannot send campaign: domain "${domainStatus.domain}" is not verified. Please verify this domain in Settings > Domains.`,
		};
	}

	// Curated-sender gate (2026-07-10 plan, decision 8). The from-address must be
	// an ENABLED campaign sender, OR custom senders must be allowed org-wide. The
	// verified-domain check above stays the floor for BOTH branches, so a custom
	// sender still cannot spoof an unverified domain.
	if (!(await isCampaignSenderAllowed(ctx, campaign.fromEmail))) {
		return {
			ok: false,
			reason: 'sender_not_allowed',
			message: `Cannot send campaign: ${senderNotAllowedMessage(campaign.fromEmail)}`,
		};
	}

	const now = options.now ?? Date.now();

	if (options.scheduledAt !== undefined) {
		if (options.scheduledAt <= now) {
			return {
				ok: false,
				reason: 'scheduled_in_past',
				message: 'Scheduled time must be in the future',
			};
		}
	}

	// BINDING capacity check (deliverability plan rev 3, P0-5) — added LAST so
	// every shipped check keeps its first-failure surface. A warming deployment
	// with no relay to overflow to can otherwise start a campaign whose tail
	// silently expires in the MTA queue. When capacity cannot be measured the
	// assessment answers `fits: true` and nothing changes.
	//
	// The projection is anchored at the moment the send actually STARTS, not at
	// pre-flight time: warming caps grow, so judging a campaign scheduled three
	// days out against today's cap would refuse sends that provably fit.
	if (options.checkCapacity !== false) {
		const capacity = await assessCampaignCapacity(ctx, {
			audience: campaign.audience,
			fromEmail: campaign.fromEmail,
			now,
			...(options.scheduledAt !== undefined ? { startsAt: options.scheduledAt } : {}),
		});
		if (!capacity.fits) {
			return {
				ok: false,
				reason: 'exceeds_sending_capacity',
				message: describeCapacitySchedule(capacity.schedule),
				capacityPlan: capacity.schedule,
			};
		}
	}

	return { ok: true };
}

/**
 * InternalQuery wrapper so actions (`emails.startCampaignSendInternal`)
 * can run the pre-flight at scheduler-tick time. Loads the campaign by
 * id and delegates to `validateReadyToSend`. Returns the same
 * `PreflightResult` union.
 *
 * The scheduler-tick path uses this to catch state that changed between
 * the original `schedule` call and the orchestrator firing — e.g., the
 * org went `suspended`, the template was deleted, the domain
 * verification expired.
 */
export const validateReadyToSendQuery = internalQuery({
	args: { campaignId: v.id('campaigns') },
	handler: async (ctx, args): Promise<PreflightResult> => {
		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) {
			return {
				ok: false,
				reason: 'not_found',
				message: 'Campaign not found',
			};
		}
		// The BINDING capacity gate is deliberately NOT re-run here: see
		// `PreflightOptions.checkCapacity`. A capacity refusal at fire time has no
		// consumer — it becomes `{ skipped: true }` and the campaign sits
		// `scheduled` forever, which is strictly worse than the expiring tail this
		// gate exists to prevent. Every shipped fire-time check still runs.
		return await validateReadyToSend(ctx, campaign, { checkCapacity: false });
	},
});
