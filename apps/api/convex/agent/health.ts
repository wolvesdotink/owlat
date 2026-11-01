/**
 * Agent health reads: the monitoring dashboard's metrics, history, cost and
 * accuracy views, and the circuit-breaker states the route step checks before
 * it lets a reply send itself. `agent/healthRollup.ts` writes what these read.
 */

import { v, type Infer } from 'convex/values';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { adminQuery } from '../lib/authedFunctions';
import { estimateCostUsd } from '../lib/llm/pricing';
import { agentMetricTypeValidator } from '../lib/literalValidators';

/** A window reaching back from now; 24 hours when unset. */
interface HoursBackArgs {
	hoursBack?: number;
}

interface MetricHistoryArgs extends HoursBackArgs {
	metricType: Infer<typeof agentMetricTypeValidator>;
}

/**
 * Get current agent health metrics for the dashboard
 */
export const getDashboardMetrics = adminQuery({
	args: {},
	handler: async (ctx) => await readDashboardMetrics(ctx),
});

export async function readDashboardMetrics(ctx: QueryCtx) {
	const now = Date.now();
	const fiveMinAgo = now - 5 * 60 * 1000;
	const _oneDayAgo = now - 24 * 60 * 60 * 1000;

	// Get recent metrics
	const recentMetrics = await ctx.db
		.query('agentMetrics')
		.withIndex('by_window_start', (q) => q.gte('windowStart', fiveMinAgo))
		.collect(); // bounded: metrics within the recent 5-minute window

	const latestByType: Record<string, number> = {};
	for (const metric of recentMetrics) {
		if (
			!latestByType[metric.metricType] ||
			metric.createdAt > (latestByType[metric.metricType + '_ts'] ?? 0)
		) {
			latestByType[metric.metricType] = metric.value;
			latestByType[metric.metricType + '_ts'] = metric.createdAt;
		}
	}

	// Get circuit breaker states
	const breakers = await ctx.db.query('agentCircuitBreakers').collect(); // bounded: one row per agent category (tiny)

	// Get pending queue depth
	const pendingMessages = await ctx.db
		.query('inboundMessages')
		.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'received'))
		.take(1000);

	// Get processing messages
	const processingMessages = await ctx.db
		.query('inboundMessages')
		.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'classifying'))
		.take(100);

	return {
		queueDepth: pendingMessages.length,
		processingCount: processingMessages.length,
		processingLatencyMs: latestByType['processing_latency'] ?? 0,
		errorRate: latestByType['error_rate'] ?? 0,
		autoApproveRatio: latestByType['auto_approve_ratio'] ?? 0,
		rejectionRate: latestByType['rejection_rate'] ?? 0,
		llmCost: latestByType['llm_cost'] ?? 0,
		circuitBreakers: breakers.map((b) => ({
			type: b.breakerType,
			state: b.state,
			currentValue: b.currentValue,
			threshold: b.threshold,
			trippedAt: b.trippedAt,
		})),
	};
}

/**
 * Get metric history for a specific metric type (for charts)
 */
export const getMetricHistory = adminQuery({
	args: {
		metricType: agentMetricTypeValidator,
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => await readMetricHistory(ctx, args),
});

export async function readMetricHistory(ctx: QueryCtx, args: MetricHistoryArgs) {
	const since = Date.now() - (args.hoursBack ?? 24) * 60 * 60 * 1000;

	return await ctx.db
		.query('agentMetrics')
		.withIndex('by_metric_type_and_window_start', (q) =>
			q.eq('metricType', args.metricType).gte('windowStart', since)
		)
		.collect(); // bounded: one metric type's rollups within the recent window (gte since)
}

/**
 * Cost by step — sum of LLM token usage on agent-pipeline actions, grouped by
 * the pipeline step (`actionType`), over a bounded recent window. Powers the
 * `cost_by_step` dashboard card. Returns one row per step that incurred tokens,
 * ordered by total cost descending, plus the window's grand total.
 */
export const getCostByStep = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => await readCostByStep(ctx, args),
});

export async function readCostByStep(ctx: QueryCtx, args: HoursBackArgs) {
	const since = Date.now() - (args.hoursBack ?? 24) * 60 * 60 * 1000;

	// bounded: windowed scan capped at 2000 most-recent actions — a busy
	// pipeline window stays well under this, and the cap keeps the read O(1).
	const actions = await ctx.db
		.query('agentActions')
		.withIndex('by_creation_time', (q) => q.gte('_creationTime', since))
		.order('desc')
		.take(2000);

	// Accumulate token usage + estimated cost per pipeline step.
	const byStep = new Map<
		string,
		{
			promptTokens: number;
			completionTokens: number;
			totalTokens: number;
			costUsd: number;
			actionCount: number;
		}
	>();
	for (const action of actions) {
		const usage = action.tokenUsage;
		if (!usage) continue;
		const acc = byStep.get(action.actionType) ?? {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			costUsd: 0,
			actionCount: 0,
		};
		acc.promptTokens += usage.promptTokens;
		acc.completionTokens += usage.completionTokens;
		acc.totalTokens += usage.totalTokens;
		acc.costUsd += estimateCostUsd(action.modelUsed, usage);
		acc.actionCount += 1;
		byStep.set(action.actionType, acc);
	}

	const steps = [...byStep.entries()]
		.map(([step, acc]) => ({ step, ...acc }))
		.sort((a, b) => b.totalTokens - a.totalTokens);

	const totalTokens = steps.reduce((sum, s) => sum + s.totalTokens, 0);
	const totalCostUsd = steps.reduce((sum, s) => sum + s.costUsd, 0);

	return { steps, totalTokens, totalCostUsd, hoursBack: args.hoursBack ?? 24 };
}

/**
 * Accuracy trend — time series of auto-approve ratio vs. rejection rate from the
 * recorded `agentMetrics` history, aligned by rollup window so the two series
 * share an x-axis. Powers the `accuracy_trend` dashboard card.
 */
export const getAccuracyTrend = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => await readAccuracyTrend(ctx, args),
});

export async function readAccuracyTrend(ctx: QueryCtx, args: HoursBackArgs) {
	const since = Date.now() - (args.hoursBack ?? 24) * 60 * 60 * 1000;

	// bounded: rollups land every 5 min, so a 24h window is ~288 points per
	// series; .take caps a wider hoursBack at a fixed ceiling.
	const autoApprove = await ctx.db
		.query('agentMetrics')
		.withIndex('by_metric_type_and_window_start', (q) =>
			q.eq('metricType', 'auto_approve_ratio').gte('windowStart', since)
		)
		.take(2000);
	const rejection = await ctx.db
		.query('agentMetrics')
		.withIndex('by_metric_type_and_window_start', (q) =>
			q.eq('metricType', 'rejection_rate').gte('windowStart', since)
		)
		.take(2000);

	// Align the two series by their rollup window start so a single point on
	// the x-axis carries both values. Missing values default to 0.
	const byWindow = new Map<
		number,
		{ windowStart: number; autoApproveRatio: number; rejectionRate: number }
	>();
	for (const m of autoApprove) {
		const point = byWindow.get(m.windowStart) ?? {
			windowStart: m.windowStart,
			autoApproveRatio: 0,
			rejectionRate: 0,
		};
		point.autoApproveRatio = m.value;
		byWindow.set(m.windowStart, point);
	}
	for (const m of rejection) {
		const point = byWindow.get(m.windowStart) ?? {
			windowStart: m.windowStart,
			autoApproveRatio: 0,
			rejectionRate: 0,
		};
		point.rejectionRate = m.value;
		byWindow.set(m.windowStart, point);
	}

	const series = [...byWindow.values()].sort((a, b) => a.windowStart - b.windowStart);

	return { series, hoursBack: args.hoursBack ?? 24 };
}

/** Internal variant for the circuit-breaker evaluator (no session). */
export const getCircuitBreakersInternal = internalQuery({
	args: {},
	handler: async (ctx) => await readCircuitBreakers(ctx),
});

export async function readCircuitBreakers(ctx: QueryCtx) {
	return await ctx.db.query('agentCircuitBreakers').collect(); // bounded: fixed small set of breaker types
}
