/**
 * Previous-release paths of `autonomy/policy.ts`. The autonomy settings page in
 * a tab opened before the deploy still calls `autonomy:*` by path, a previous
 * release's route step or threshold cron still running when this one deploys
 * calls these internal functions by their old paths, and so does a daily-count
 * reset the previous release's cron queued. Each function keeps its old path,
 * builder, auth floor, arguments and result shape, and runs the same body as
 * its replacement. Remove after release 0.6.17.
 */
import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import type { Id } from './_generated/dataModel';
import { adminQuery, authedMutation } from './lib/authedFunctions';
import { hasPermission, requirePermission } from './lib/sessionOrganization';
import { assertFeatureEnabled } from './lib/featureFlags';
import {
	chargeDailyCount,
	decideAutonomy,
	readRules,
	resetAllDailyCounts,
	writeCategoryRule,
	writeSenderRule,
} from './autonomy/policy';

/** Remove after release 0.6.17; this release calls `autonomy/policy:listRules`. */
export const listRules = adminQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.autonomy');
		return await readRules(ctx);
	},
});

/** Remove after release 0.6.17; this release calls `autonomy/policy:listRulesInternal`. */
export const listRulesInternal = internalQuery({
	args: {},
	handler: async (ctx) => await readRules(ctx),
});

/** Remove after release 0.6.17; this release calls `autonomy/policy:checkPermissionInternal`. */
export const checkPermissionInternal = internalQuery({
	args: {
		category: v.string(),
		confidence: v.number(),
		inboundMessageId: v.optional(v.id('inboundMessages')),
	},
	handler: async (ctx, args) => await decideAutonomy(ctx, args),
});

/** Remove after release 0.6.17; this release calls `autonomy/policy:upsertRule`. */
export const upsertRule = authedMutation({
	args: {
		category: v.string(),
		autoApproveThreshold: v.number(),
		maxDailyAutoActions: v.number(),
		isEnabled: v.boolean(),
	},
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can change autonomy rules'
		);
		return await writeCategoryRule(ctx, args);
	},
});

/** Remove after release 0.6.17; this release calls `autonomy/policy:setSenderAutonomy`. */
export const setSenderAutonomy = authedMutation({
	args: {
		category: v.string(),
		sender: v.string(),
		isEnabled: v.boolean(),
		autoApproveThreshold: v.optional(v.number()),
		maxDailyAutoActions: v.optional(v.number()),
		warmupRequired: v.optional(v.number()),
	},
	handler: async (ctx, args, session): Promise<Id<'autonomyRules'>> => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can change autonomy rules'
		);
		return await writeSenderRule(ctx, args);
	},
});

/** Remove after release 0.6.17; this release calls `autonomy/policy:deleteRule`. */
export const deleteRule = authedMutation({
	args: { ruleId: v.id('autonomyRules') },
	handler: async (ctx, args, session) => {
		requirePermission(
			hasPermission(session.role, 'organization:manage'),
			'Only owners and admins can delete autonomy rules'
		);
		await ctx.db.delete(args.ruleId);
	},
});

/** Remove after release 0.6.17; this release calls `autonomy/policy:incrementDailyCount`. */
export const incrementDailyCount = internalMutation({
	args: {
		category: v.string(),
		inboundMessageId: v.optional(v.id('inboundMessages')),
	},
	handler: async (ctx, args) => await chargeDailyCount(ctx, args),
});

/** Remove after release 0.6.17; this release's cron calls `autonomy/policy:resetDailyCounts`. */
export const resetDailyCounts = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => await resetAllDailyCounts(ctx),
});
