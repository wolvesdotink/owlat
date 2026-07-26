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

/**
 * The multi-day schedule handed back instead of an error when the audience
 * provably cannot be delivered inside the MTA's message-retention horizon.
 * Capacity is a SCHEDULE, not a failure — the UI renders "Sending over N days".
 */
export interface PreflightCapacityPlan {
	days: number;
	slices: number[];
	finishesAt: number;
}

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
			capacityPlan?: PreflightCapacityPlan;
	  };

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
	const capacity = await assessCampaignCapacity(ctx, { audience: campaign.audience, now });
	if (!capacity.fits) {
		return {
			ok: false,
			reason: 'exceeds_sending_capacity',
			message:
				`This campaign is larger than your sending capacity allows in one go. ` +
				`At your current warm-up capacity it takes about ${capacity.days} day${capacity.days === 1 ? '' : 's'} ` +
				`to reach everyone, so send it over ${capacity.days} days instead.`,
			capacityPlan: {
				days: capacity.days,
				slices: capacity.slices,
				finishesAt: capacity.finishesAt,
			},
		};
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
		return await validateReadyToSend(ctx, campaign);
	},
});
