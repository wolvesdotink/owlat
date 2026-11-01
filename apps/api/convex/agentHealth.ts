/**
 * Previous-release paths of `agent/health.ts` and `agent/healthRollup.ts`. The
 * agent health page and the cost and accuracy cards in a tab opened before the
 * deploy still read through `agentHealth:*` by path, and a previous release's
 * route step or metrics rollup still running when this one deploys calls the
 * internal functions by their old paths (the rollup cron's queued run too).
 * Each function keeps its old path, builder, auth floor, arguments and result
 * shape, and runs the same body as its replacement. Remove after release 0.6.17.
 */

import { v } from 'convex/values';
import { internalQuery, internalAction } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import { adminQuery } from './lib/authedFunctions';
import { agentMetricTypeValidator } from './lib/literalValidators';
import {
	readAccuracyTrend,
	readCircuitBreakers,
	readCostByStep,
	readDashboardMetrics,
	readMetricHistory,
} from './agent/health';
import {
	agentMetricRowValidator,
	breakerTypeValidator,
	countPendingMessages,
	insertMetrics,
	readRecentActions,
	runRollup,
	writeCircuitBreaker,
} from './agent/healthRollup';

/** Remove after release 0.6.17; this release calls `agent/health:getDashboardMetrics`. */
export const getDashboardMetrics = adminQuery({
	args: {},
	handler: async (ctx) => await readDashboardMetrics(ctx),
});

/** Remove after release 0.6.17; this release calls `agent/health:getMetricHistory`. */
export const getMetricHistory = adminQuery({
	args: {
		metricType: agentMetricTypeValidator,
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => await readMetricHistory(ctx, args),
});

/** Remove after release 0.6.17; this release calls `agent/health:getCostByStep`. */
export const getCostByStep = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => await readCostByStep(ctx, args),
});

/** Remove after release 0.6.17; this release calls `agent/health:getAccuracyTrend`. */
export const getAccuracyTrend = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => await readAccuracyTrend(ctx, args),
});

/** Remove after release 0.6.17; this release calls `agent/health:getCircuitBreakersInternal`. */
export const getCircuitBreakersInternal = internalQuery({
	args: {},
	handler: async (ctx) => await readCircuitBreakers(ctx),
});

/** Remove after release 0.6.17; this release calls `agent/healthRollup:rollupMetrics`. */
export const rollupMetrics = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => await runRollup(ctx),
});

/** Remove after release 0.6.17; this release calls `agent/healthRollup:getRecentActions`. */
export const getRecentActions = internalQuery({
	args: { since: v.number() },
	handler: async (ctx, args) => await readRecentActions(ctx, args),
});

/** Remove after release 0.6.17; this release calls `agent/healthRollup:getPendingCount`. */
export const getPendingCount = internalQuery({
	args: {},
	handler: async (ctx) => await countPendingMessages(ctx),
});

/**
 * A previous release's rollup writes its window here. Nothing in this release
 * calls it; remove after release 0.6.17.
 */
export const recordMetrics = internalMutation({
	args: { metrics: v.array(agentMetricRowValidator) },
	returns: v.null(),
	handler: async (ctx, args) => {
		await insertMetrics(ctx, args.metrics);
	},
});

/**
 * A previous release's rollup moves a breaker here. Nothing in this release
 * calls it; remove after release 0.6.17.
 */
export const updateCircuitBreaker = internalMutation({
	args: {
		breakerType: breakerTypeValidator,
		state: v.union(v.literal('closed'), v.literal('open'), v.literal('half_open')),
		currentValue: v.number(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('agentCircuitBreakers')
			.withIndex('by_breaker_type', (q) => q.eq('breakerType', args.breakerType))
			.first();
		await writeCircuitBreaker(ctx, existing, args.breakerType, args.state, args.currentValue);
	},
});
