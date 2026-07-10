import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { throwInvalidState, throwNotFound } from '../_utils/errors';
import { validateReadyToSend } from './preflight';
import { seedDefaultSenderIfNeeded } from './senders';
import { assertTransitioned } from './lifecycle';
import { recordAuditLog } from '../lib/auditLog';

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

		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) {
			throwNotFound('Campaign');
		}

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

		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) {
			throwNotFound('Campaign');
		}

		if (campaign.status !== 'scheduled') {
			throwInvalidState('Only scheduled campaigns can be rescheduled');
		}

		// Ensure scheduled time is in the future
		if (args.scheduledAt <= Date.now()) {
			throwInvalidState('Scheduled time must be in the future');
		}

		// Reschedule is a "stay in scheduled, replace scheduledAt" operation, not a
		// status transition. We don't cancel the original hop; instead
		// startCampaignSend re-checks scheduledAt at fire time and skips while the
		// campaign isn't due yet (scheduledAt > now), so the stale original hop is a
		// harmless no-op and the new hop sends on time.
		await ctx.db.patch(args.campaignId, {
			scheduledAt: args.scheduledAt,
			...(args.useRecipientTimezone !== undefined
				? { useRecipientTimezone: args.useRecipientTimezone }
				: {}),
			...(args.scheduledHour !== undefined ? { scheduledHour: args.scheduledHour } : {}),
			...(args.scheduledMinute !== undefined ? { scheduledMinute: args.scheduledMinute } : {}),
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

		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) {
			throwNotFound('Campaign');
		}

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

		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) {
			throwNotFound('Campaign');
		}

		if (campaign.status !== 'draft') {
			throwInvalidState('Only draft campaigns can be scheduled');
		}

		// Bootstrap the curated list from the org default before pre-flight so an
		// upgraded deployment (empty list, toggle off) can still schedule from its
		// own default address instead of failing `sender_not_allowed`.
		await seedDefaultSenderIfNeeded(ctx);

		const preflight = await validateReadyToSend(ctx, campaign, {
			scheduledAt: args.scheduledAt,
		});
		if (!preflight.ok) {
			throwInvalidState(preflight.message);
		}

		const outcome = await ctx.runMutation(internal.campaigns.lifecycle.transition, {
			campaignId: args.campaignId,
			input: {
				to: 'scheduled',
				at: Date.now(),
				scheduledAt: args.scheduledAt,
				...(args.useRecipientTimezone !== undefined
					? { useRecipientTimezone: args.useRecipientTimezone }
					: {}),
				...(args.scheduledHour !== undefined ? { scheduledHour: args.scheduledHour } : {}),
				...(args.scheduledMinute !== undefined ? { scheduledMinute: args.scheduledMinute } : {}),
			},
			userId: session.userId,
		});

		assertTransitioned(outcome, 'schedule');

		return args.campaignId;
	},
});

/**
 * Internal query to find campaigns stuck in 'sending' status for too long.
 * Used by a watchdog to detect and recover failed sends.
 */
export const listStuckCampaigns = internalQuery({
	args: {},
	handler: async (ctx) => {
		const sendingCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'sending'))
			.collect(); // bounded: in-flight campaigns only

		const now = Date.now();
		const stuckThreshold = 30 * 60 * 1000; // 30 minutes

		return sendingCampaigns.filter((c) => {
			const startedAt = c.updatedAt || c._creationTime;
			return now - startedAt > stuckThreshold;
		});
	},
});
