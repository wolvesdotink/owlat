/**
 * Previous-release paths of `autonomy/feedback.ts`. The AI replies page in a tab
 * opened before the deploy still calls `autonomyFeedback:getFeedbackStats` by
 * path, and a previous release's threshold cron or metrics rollup still running
 * when this one deploys calls these internal functions by their old paths. Each
 * function keeps its old path, builder, arguments and result shape, and runs
 * the same body as its replacement. Remove after release 0.6.17.
 */
import { v } from 'convex/values';
import { internalQuery, internalAction } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import { adminQuery } from './lib/authedFunctions';
import { omit } from './lib/validators/fields';
import { autonomyFeedbackFields } from './schema/autonomy';
import {
	countFeedbackSince,
	insertFeedback,
	loadRecentFeedback,
	readFeedbackStats,
	runThresholdAdjustment,
} from './autonomy/feedback';

/** Remove after release 0.6.17; this release calls `autonomy/feedback:getRecentFeedbackInternal`. */
export const getRecentFeedbackInternal = internalQuery({
	args: {
		category: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => await loadRecentFeedback(ctx, args.category, args.limit),
});

/** Remove after release 0.6.17; this release calls `autonomy/feedback:getFeedbackStats`. */
export const getFeedbackStats = adminQuery({
	args: { hoursBack: v.optional(v.number()) },
	handler: async (ctx, args) => await readFeedbackStats(ctx, args.hoursBack),
});

/** Remove after release 0.6.17; this release calls `autonomy/feedback:getFeedbackCountsInternal`. */
export const getFeedbackCountsInternal = internalQuery({
	args: { since: v.number() },
	handler: async (ctx, args) => await countFeedbackSince(ctx, args.since),
});

/** Remove after release 0.6.17; this release calls `autonomy/feedback:recordFeedback`. */
export const recordFeedback = internalMutation({
	args: omit(autonomyFeedbackFields, ['ruleId', 'createdAt']),
	handler: async (ctx, args) => await insertFeedback(ctx, args),
});

/** Remove after release 0.6.17; this release's cron calls `autonomy/feedback:adjustThresholds`. */
export const adjustThresholds = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		await runThresholdAdjustment(ctx);
		return null;
	},
});

/**
 * A previous release's threshold cron tightens a rule here. Nothing in this
 * release calls it; remove after release 0.6.17.
 */
export const updateThreshold = internalMutation({
	args: {
		ruleId: v.id('autonomyRules'),
		newThreshold: v.number(),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.ruleId, {
			autoApproveThreshold: args.newThreshold,
			updatedAt: Date.now(),
		});
	},
});
