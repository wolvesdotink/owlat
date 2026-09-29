import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { getOrThrow, throwInvalidState } from '../_utils/errors';
import { preflightErrorData, validateReadyToSend } from './preflight';
import { seedDefaultSenderIfNeeded } from './senders';
import { assertTransitioned } from './lifecycle';
import { recordAuditLog } from '../lib/auditLog';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

/**
 * The pre-flight every path that puts a campaign on the clock runs: `schedule`
 * (draft to scheduled) and `reschedule` (a new start for a scheduled one).
 * Capacity is judged against the start time because warming caps grow, so a
 * new start has to be judged again: pulling a campaign that fit a week out
 * forward to tomorrow can overrun what the IPs can send before the MTA queue
 * expires the tail. The same run re-checks the sender allow-list, domain
 * verification and "scheduled in the past".
 *
 * The fire-time re-check (`validateReadyToSendQuery`) stays separate and skips
 * capacity on purpose: nobody is there to act on a refusal at fire time.
 */
async function assertSchedulable(
	ctx: MutationCtx,
	campaign: Doc<'campaigns'>,
	scheduledAt: number
): Promise<void> {
	// Bootstrap the curated list from the org default before pre-flight so an
	// upgraded deployment (empty list, toggle off) can still schedule from its
	// own default address instead of failing `sender_not_allowed`.
	await seedDefaultSenderIfNeeded(ctx);

	const preflight = await validateReadyToSend(ctx, campaign, { scheduledAt });
	if (!preflight.ok) {
		// Carry the structured refusal (and, for a capacity refusal, the
		// multi-day plan) so the client can offer "send over N days" as a
		// first-class choice instead of just showing prose.
		throwInvalidState(preflight.message, preflightErrorData(preflight));
	}
}

interface SchedulingOptions {
	useRecipientTimezone?: boolean;
	scheduledHour?: number;
	scheduledMinute?: number;
}

/**
 * The recipient-timezone controls `schedule` and `reschedule` both accept, with
 * the omitted ones left out so a write does not clear a stored value.
 */
function pickSchedulingOptions(args: SchedulingOptions): SchedulingOptions {
	return {
		...(args.useRecipientTimezone !== undefined
			? { useRecipientTimezone: args.useRecipientTimezone }
			: {}),
		...(args.scheduledHour !== undefined ? { scheduledHour: args.scheduledHour } : {}),
		...(args.scheduledMinute !== undefined ? { scheduledMinute: args.scheduledMinute } : {}),
	};
}

// Mutation to cancel a scheduled campaign
export const cancel = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'campaigns:schedule',
			'You do not have permission to cancel campaigns'
		);

		const campaign = await getOrThrow(ctx, args.campaignId, 'Campaign');

		if (campaign.status !== 'scheduled') {
			throwInvalidState('Only scheduled campaigns can be cancelled');
		}

		const outcome = await ctx.runMutation(internal.campaigns.lifecycle.transition, {
			campaignId: args.campaignId,
			input: { to: 'cancelled', at: Date.now() },
			userId: session.userId,
		});

		assertTransitioned(outcome, 'cancel');

		return args.campaignId;
	},
});

// Mutation to reschedule a campaign to a different time
export const reschedule = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
		scheduledAt: v.number(),
		// Same recipient-timezone staggering controls as the draft `schedule`
		// path, so editing a scheduled campaign can turn local-time delivery
		// on/off and change the target local hour (not just the start instant).
		// Omitted args leave the stored values untouched.
		useRecipientTimezone: v.optional(v.boolean()),
		scheduledHour: v.optional(v.number()),
		scheduledMinute: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'campaigns:schedule',
			'You do not have permission to reschedule campaigns'
		);

		const campaign = await getOrThrow(ctx, args.campaignId, 'Campaign');

		if (campaign.status !== 'scheduled') {
			throwInvalidState('Only scheduled campaigns can be rescheduled');
		}

		// The same pre-flight as `schedule`, anchored at the new start: capacity,
		// sender allow-list, domain verification and the future-time check.
		await assertSchedulable(ctx, campaign, args.scheduledAt);

		// Reschedule is a "stay in scheduled, replace scheduledAt" operation, not a
		// status transition. We don't cancel the original hop; instead
		// startCampaignSend re-checks scheduledAt at fire time and skips while the
		// campaign isn't due yet (scheduledAt > now), so the stale original hop is a
		// harmless no-op and the new hop sends on time.
		await ctx.db.patch(args.campaignId, {
			scheduledAt: args.scheduledAt,
			...pickSchedulingOptions(args),
			updatedAt: Date.now(),
		});

		// Audit the send-time change — reschedule replaces scheduledAt without a
		// status transition, so the lifecycle audit wouldn't otherwise fire.
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'campaign.scheduled',
			resource: 'campaign',
			resourceId: args.campaignId,
			details: { scheduledAt: args.scheduledAt, rescheduled: true },
		});

		const delayMs = args.scheduledAt - Date.now();
		await ctx.scheduler.runAfter(delayMs, internal.campaigns.send.startCampaignSend, {
			campaignId: args.campaignId,
		});

		return args.campaignId;
	},
});

// Mutation to unschedule a campaign (convert back to draft for editing)
export const unschedule = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(
			ctx,
			'campaigns:schedule',
			'You do not have permission to unschedule campaigns'
		);

		const campaign = await getOrThrow(ctx, args.campaignId, 'Campaign');

		if (campaign.status !== 'scheduled') {
			throwInvalidState('Only scheduled campaigns can be unscheduled');
		}

		const outcome = await ctx.runMutation(internal.campaigns.lifecycle.transition, {
			campaignId: args.campaignId,
			input: { to: 'draft', at: Date.now() },
			userId: session.userId,
		});

		assertTransitioned(outcome, 'unschedule');

		return args.campaignId;
	},
});

// Schedule a campaign using session-based context.
export const schedule = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
		scheduledAt: v.number(),
		useRecipientTimezone: v.optional(v.boolean()),
		scheduledHour: v.optional(v.number()),
		scheduledMinute: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// Deliberately NOT requireDraftCampaign: scheduling is gated on the
		// distinct campaigns:schedule permission, while the guard hard-codes
		// campaigns:manage. Same shape, different authz decision.
		const session = await requireOrgPermission(
			ctx,
			'campaigns:schedule',
			'You do not have permission to schedule campaigns'
		);

		const campaign = await getOrThrow(ctx, args.campaignId, 'Campaign');

		if (campaign.status !== 'draft') {
			throwInvalidState('Only draft campaigns can be scheduled');
		}

		await assertSchedulable(ctx, campaign, args.scheduledAt);

		const outcome = await ctx.runMutation(internal.campaigns.lifecycle.transition, {
			campaignId: args.campaignId,
			input: {
				to: 'scheduled',
				at: Date.now(),
				scheduledAt: args.scheduledAt,
				...pickSchedulingOptions(args),
			},
			userId: session.userId,
		});

		assertTransitioned(outcome, 'schedule');

		return args.campaignId;
	},
});
