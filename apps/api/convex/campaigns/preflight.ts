/**
 * Campaign send pre-flight — the one check block every path that moves a
 * campaign towards `sending` runs. The lifecycle reducer trusts its input;
 * callers run this helper *before* `lifecycle.transition`.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { checkEmailDomainVerification } from '../domains/domains';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { isDeliveryConfigured } from '../lib/sendProviders/capability';
import { isCampaignSenderAllowed, senderNotAllowedMessage } from './senders';
import { assessCampaignCapacity } from './capacityPreflight';
import { assessCampaignMailServer, type MailServerBlock } from './mailServerPreflight';
import { MAX_PLAN_DAYS, type CampaignCapacitySchedule } from './capacityPlan';
import { getLive } from '../lib/softDelete';
import { campaignsQuery } from './_helpers';
import {
	preflightMessageKey,
	type PreflightFailureReason,
	type PreflightMessageKey,
	type PreflightMessageParams,
	type PreflightMessageVariant,
} from './refusalCopy';

export type PreflightResult =
	| { ok: true }
	| {
			ok: false;
			reason: PreflightFailureReason;
			/** English, for API consumers and logs. */
			message: string;
			/** The catalog key a client renders instead of `message` (`refusalCopy.ts`). */
			messageKey: PreflightMessageKey;
			messageParams?: PreflightMessageParams;
			/** Present only on `exceeds_sending_capacity`. */
			capacityPlan?: CampaignCapacitySchedule;
	  };

type PreflightFailure = Extract<PreflightResult, { ok: false }>;

/** One refusal, with its English sentence and the catalog key for the same words. */
function refuse<R extends PreflightFailureReason>(
	reason: R,
	variant: PreflightMessageVariant<R>,
	message: string,
	messageParams?: PreflightMessageParams
): PreflightFailure {
	return {
		ok: false,
		reason,
		message,
		messageKey: preflightMessageKey(reason, variant),
		...(messageParams ? { messageParams } : {}),
	};
}

/**
 * Structured error payload for a failed pre-flight. `capacityPlan` is what
 * turns "too big" from prose into an offer: the client can render "send over N
 * days" straight from the refusal instead of re-deriving it. `reason` keeps its
 * union type — widening it to `string` would throw away the discriminant the
 * client needs to branch on.
 */
export function preflightErrorData(result: PreflightFailure): {
	reason: PreflightFailureReason;
	messageKey: PreflightMessageKey;
	messageParams?: PreflightMessageParams;
	capacityPlan?: CampaignCapacitySchedule;
} {
	return {
		reason: result.reason,
		messageKey: result.messageKey,
		...(result.messageParams ? { messageParams: result.messageParams } : {}),
		...(result.capacityPlan ? { capacityPlan: result.capacityPlan } : {}),
	};
}

export interface PreflightOptions {
	/**
	 * If set, enables the future-date check (`scheduled_in_past`). Omit
	 * for callers that aren't tied to a future timestamp.
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
 * as much as the plan actually knows (say the quiet part):
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
	// Always PLURAL, and not by oversight: a refusal with `days === 1` cannot be
	// constructed. Covering the audience on day 0 requires
	// `capacityForDay(0) >= audienceSize`, which makes horizon capacity at least
	// the audience for any horizon of one day or more — so `planCampaignCapacity`
	// answers `{ fits: true }` and this function is never reached. A singular
	// branch here would be dead code carrying a maintenance cost and an implied
	// promise the planner does not make.
	if (schedule.audienceUnderCounted) {
		return (
			`${opening}it takes at least ${schedule.days} days to reach everyone, ` +
			`so send it over several days instead.`
		);
	}
	return (
		`${opening}it takes about ${schedule.days} days to reach everyone, ` +
		`so send it over ${schedule.days} days instead.`
	);
}

/**
 * The catalog form of {@link describeCapacitySchedule}: the same three tails,
 * picked by the same rules.
 */
function capacityRefusal(schedule: CampaignCapacitySchedule): PreflightFailure {
	const message = describeCapacitySchedule(schedule);
	const failure = schedule.truncated
		? refuse('exceeds_sending_capacity', 'truncated', message, { maxDays: MAX_PLAN_DAYS })
		: schedule.audienceUnderCounted
			? refuse('exceeds_sending_capacity', 'atLeast', message, { days: schedule.days })
			: refuse('exceeds_sending_capacity', 'about', message, { days: schedule.days });
	return { ...failure, capacityPlan: schedule };
}

type Ctx = MutationCtx | QueryCtx;

const MAIL_SERVER_BLOCK_MESSAGE: Record<MailServerBlock, string> = {
	unreachable:
		'Cannot send campaign: the built-in mail server is not answering its health check, so the mail would wait in its queue. Check the mail server under Delivery.',
	port25Blocked:
		'Cannot send campaign: the built-in mail server cannot reach other mail servers on port 25 from any campaign sending IP. Many hosts block port 25 until you ask them to open it.',
	allIpsHeld:
		'Cannot send campaign: every campaign sending IP of the built-in mail server is held back (blocklist, PTR or SPF problem). Fix the held IPs under Delivery.',
};

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
		return refuse('no_template', 'missing', 'Campaign must have an email template selected');
	}
	// A template in Recently deleted cannot be sent; restoring it, or picking
	// another, clears this.
	if (!(await getLive(ctx, campaign.emailTemplateId))) {
		return refuse('no_template', 'deleted', "The campaign's email template was deleted");
	}

	if (!campaign.audience) {
		return refuse('no_audience', 'default', 'Campaign must have an audience configured');
	}

	if (!campaign.fromEmail) {
		return refuse('no_from_email', 'default', 'Campaign must have a from email address');
	}

	const settings = await ctx.db.query('instanceSettings').first();
	const status = settings?.abuseStatus;
	if (status === 'suspended') {
		return refuse(
			'sending_not_allowed',
			'suspended',
			'Your account has been suspended due to policy violations. Please contact support for assistance.'
		);
	}
	if (status === 'banned') {
		return refuse(
			'sending_not_allowed',
			'banned',
			'Your account has been permanently disabled. Please contact support for more information.'
		);
	}

	// A delivery provider must actually be configured before the domain check —
	// bulk campaigns dispatch through the composed provider abstraction,
	// never through a user's external IMAP mailbox. Without one, refuse here so
	// zero `emailSends` rows are written instead of marching every recipient to
	// `failed` against a provider that was never set up.
	if (!(await isDeliveryConfigured(ctx, 'campaign'))) {
		return refuse(
			'no_delivery_provider',
			'default',
			'Cannot send campaign: no email delivery provider is configured. Set a delivery provider (EMAIL_PROVIDER + credentials, or a provider route) in Settings. A connected external mailbox does not provide bulk delivery.'
		);
	}

	// The helper, not the public query: the scheduler and the send orchestrator
	// run this with no signed-in member, and the query's member check would
	// throw there and leave the campaign unstarted.
	const domainStatus = await checkEmailDomainVerification(ctx, campaign.fromEmail);

	if (!domainStatus.verified) {
		const message =
			domainStatus.error ??
			`Cannot send campaign: domain "${domainStatus.domain}" is not verified. Please verify this domain in Settings > Domains.`;
		// An address with no domain part has no domain to name.
		if (!domainStatus.domain) {
			return refuse('domain_not_verified', 'invalidAddress', message, {
				email: campaign.fromEmail,
			});
		}
		return refuse('domain_not_verified', domainStatus.exists ? 'unverified' : 'missing', message, {
			domain: domainStatus.domain,
		});
	}

	// Curated-sender gate. The from-address must be
	// an ENABLED campaign sender, OR custom senders must be allowed org-wide. The
	// verified-domain check above stays the floor for BOTH branches, so a custom
	// sender still cannot spoof an unverified domain.
	if (!(await isCampaignSenderAllowed(ctx, campaign.fromEmail))) {
		return refuse(
			'sender_not_allowed',
			'default',
			`Cannot send campaign: ${senderNotAllowedMessage(campaign.fromEmail)}`,
			{ email: campaign.fromEmail }
		);
	}

	const now = options.now ?? Date.now();

	// The built-in mail server must be able to deliver right now, judged from
	// its last fresh health snapshot exactly as the Delivery hub judges it.
	// Stale or missing health never refuses.
	const mailServerBlock = await assessCampaignMailServer(ctx, now);
	if (mailServerBlock) {
		return refuse(
			'mail_server_not_ready',
			mailServerBlock,
			MAIL_SERVER_BLOCK_MESSAGE[mailServerBlock]
		);
	}

	if (options.scheduledAt !== undefined) {
		if (options.scheduledAt <= now) {
			return refuse('scheduled_in_past', 'default', 'Scheduled time must be in the future');
		}
	}

	// BINDING capacity check — added LAST so
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
		if (!capacity.fits) return capacityRefusal(capacity.schedule);
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
		const campaign = await getLive(ctx, args.campaignId);
		if (!campaign) return refuse('not_found', 'default', 'Campaign not found');
		// The BINDING capacity gate is deliberately NOT re-run here: see
		// `PreflightOptions.checkCapacity`. A capacity refusal at fire time has no
		// consumer — it becomes `{ skipped: true }` and the campaign sits
		// `scheduled` forever, which is strictly worse than the expiring tail this
		// gate exists to prevent. Every shipped fire-time check still runs.
		return await validateReadyToSend(ctx, campaign, { checkCapacity: false });
	},
});

/**
 * Whether campaign mail has a delivery provider at all: the pre-flight's own
 * `no_delivery_provider` check, so the campaign editor and the wizard can say
 * "sending is not set up" before the click instead of after it. The onboarding
 * signal (`auth/sendReadyNotices.getState`) answers a different question (can
 * the caller's own mailbox send), and would disagree with the gate on an
 * instance whose MTA serves personal mail but has no campaign route.
 */
// all-members: a capability boolean with no provider, credential or route
// detail, the same answer a schedule attempt by any member would reveal.
export const getCampaignDeliveryConfigured = campaignsQuery({
	args: {},
	handler: async (ctx): Promise<boolean> => await isDeliveryConfigured(ctx, 'campaign'),
});
