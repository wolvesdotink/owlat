/**
 * Agent Health Monitoring
 *
 * Records metrics, evaluates circuit breakers, and provides
 * dashboard queries for monitoring the AI agent pipeline.
 * Follows the circuit breaker pattern from the MTA.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation, internalAction, type ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { adminQuery } from './lib/authedFunctions';
import { internal } from './_generated/api';
import { estimateCostUsd } from './lib/llm/pricing';


// ============================================================
// Dashboard Queries
// ============================================================

/**
 * Get current agent health metrics for the dashboard
 */
export const getDashboardMetrics = adminQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const fiveMinAgo = now - 5 * 60 * 1000;
		const _oneDayAgo = now - 24 * 60 * 60 * 1000;

		// Get recent metrics
		const recentMetrics = await ctx.db
			.query('agentMetrics')
			.withIndex('by_window_start', (q) => q.gte('windowStart', fiveMinAgo))
			.collect();

		const latestByType: Record<string, number> = {};
		for (const metric of recentMetrics) {
			if (!latestByType[metric.metricType] || metric.createdAt > (latestByType[metric.metricType + '_ts'] ?? 0)) {
				latestByType[metric.metricType] = metric.value;
				latestByType[metric.metricType + '_ts'] = metric.createdAt;
			}
		}

		// Get circuit breaker states
		const breakers = await ctx.db.query('agentCircuitBreakers').collect();

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
	},
});

/**
 * Get metric history for a specific metric type (for charts)
 */
export const getMetricHistory = adminQuery({
	args: {
		metricType: v.union(
			v.literal('queue_depth'),
			v.literal('processing_latency'),
			v.literal('classification_accuracy'),
			v.literal('auto_approve_ratio'),
			v.literal('rejection_rate'),
			v.literal('llm_cost'),
			v.literal('error_rate')
		),
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const since = Date.now() - (args.hoursBack ?? 24) * 60 * 60 * 1000;

		return await ctx.db
			.query('agentMetrics')
			.withIndex('by_metric_type', (q) => q.eq('metricType', args.metricType))
			.filter((q) => q.gte(q.field('windowStart'), since))
			.collect();
	},
});

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
	handler: async (ctx, args) => {
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
			{ promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number; actionCount: number }
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
	},
});

/**
 * Accuracy trend — time series of auto-approve ratio vs. rejection rate from the
 * recorded `agentMetrics` history, aligned by rollup window so the two series
 * share an x-axis. Powers the `accuracy_trend` dashboard card.
 */
export const getAccuracyTrend = adminQuery({
	args: {
		hoursBack: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const since = Date.now() - (args.hoursBack ?? 24) * 60 * 60 * 1000;

		// bounded: rollups land every 5 min, so a 24h window is ~288 points per
		// series; .take caps a wider hoursBack at a fixed ceiling.
		const autoApprove = await ctx.db
			.query('agentMetrics')
			.withIndex('by_metric_type', (q) => q.eq('metricType', 'auto_approve_ratio'))
			.filter((q) => q.gte(q.field('windowStart'), since))
			.take(2000);
		const rejection = await ctx.db
			.query('agentMetrics')
			.withIndex('by_metric_type', (q) => q.eq('metricType', 'rejection_rate'))
			.filter((q) => q.gte(q.field('windowStart'), since))
			.take(2000);

		// Align the two series by their rollup window start so a single point on
		// the x-axis carries both values. Missing values default to 0.
		const byWindow = new Map<number, { windowStart: number; autoApproveRatio: number; rejectionRate: number }>();
		for (const m of autoApprove) {
			const point = byWindow.get(m.windowStart) ?? { windowStart: m.windowStart, autoApproveRatio: 0, rejectionRate: 0 };
			point.autoApproveRatio = m.value;
			byWindow.set(m.windowStart, point);
		}
		for (const m of rejection) {
			const point = byWindow.get(m.windowStart) ?? { windowStart: m.windowStart, autoApproveRatio: 0, rejectionRate: 0 };
			point.rejectionRate = m.value;
			byWindow.set(m.windowStart, point);
		}

		const series = [...byWindow.values()].sort((a, b) => a.windowStart - b.windowStart);

		return { series, hoursBack: args.hoursBack ?? 24 };
	},
});

/**
 * Get circuit breaker status
 */
export const getCircuitBreakers = adminQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db.query('agentCircuitBreakers').collect();
	},
});

/** Internal variant for the circuit-breaker evaluator (no session). */
export const getCircuitBreakersInternal = internalQuery({
	args: {},
	handler: async (ctx) => {
		return await ctx.db.query('agentCircuitBreakers').collect(); // bounded: fixed small set of breaker types
	},
});

// ============================================================
// Internal Mutations
// ============================================================

/**
 * Record a metric data point
 */
export const recordMetric = internalMutation({
	args: {
		metricType: v.union(
			v.literal('queue_depth'),
			v.literal('processing_latency'),
			v.literal('classification_accuracy'),
			v.literal('auto_approve_ratio'),
			v.literal('rejection_rate'),
			v.literal('llm_cost'),
			v.literal('error_rate')
		),
		value: v.number(),
		windowStart: v.number(),
		windowEnd: v.number(),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert('agentMetrics', {
			...args,
			createdAt: Date.now(),
		});
	},
});

/**
 * Update or create a circuit breaker
 */
export const updateCircuitBreaker = internalMutation({
	args: {
		breakerType: v.union(
			v.literal('llm_failure'),
			v.literal('confidence_degradation'),
			v.literal('rejection_spike')
		),
		state: v.union(v.literal('closed'), v.literal('open'), v.literal('half_open')),
		currentValue: v.number(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('agentCircuitBreakers')
			.withIndex('by_breaker_type', (q) => q.eq('breakerType', args.breakerType))
			.first();

		const now = Date.now();

		if (existing) {
			const patch: Partial<Doc<'agentCircuitBreakers'>> = {
				state: args.state,
				currentValue: args.currentValue,
			};
			if (args.state === 'open' && existing.state !== 'open') {
				patch.trippedAt = now;
			}
			if (args.state === 'closed' && existing.state !== 'closed') {
				patch.recoveredAt = now;
			}
			await ctx.db.patch(existing._id, patch);
		} else {
			await ctx.db.insert('agentCircuitBreakers', {
				breakerType: args.breakerType,
				state: args.state,
				threshold: getDefaultThreshold(args.breakerType),
				currentValue: args.currentValue,
				createdAt: now,
			});
		}
	},
});

/**
 * Clean up old metrics (keep last 7 days)
 */
export const cleanupOldMetrics = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

		const old = await ctx.db
			.query('agentMetrics')
			.withIndex('by_window_start', (q) => q.lt('windowStart', sevenDaysAgo))
			.take(500);

		for (const metric of old) {
			await ctx.db.delete(metric._id);
		}
	},
});

// ============================================================
// Internal Action: Metrics Rollup (called by cron)
// ============================================================

/**
 * Compute and record metrics from recent pipeline activity.
 * Called every 5 minutes by cron.
 */
export const rollupMetrics = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const windowStart = now - 5 * 60 * 1000;

		// Get recent agent actions for this window
		const actions = await ctx.runQuery(internal.agentHealth.getRecentActions, {
			since: windowStart,
		});

		// Queue depth: count pending messages
		const queueDepth = await ctx.runQuery(internal.agentHealth.getPendingCount);
		await ctx.runMutation(internal.agentHealth.recordMetric, {
			metricType: 'queue_depth',
			value: queueDepth,
			windowStart,
			windowEnd: now,
		});

		// Processing latency: average duration of completed actions
		const completedActions = actions.filter((a) => a.status === 'completed' && a.durationMs);
		if (completedActions.length > 0) {
			const avgLatency = completedActions.reduce((sum, a) => sum + (a.durationMs ?? 0), 0) / completedActions.length;
			await ctx.runMutation(internal.agentHealth.recordMetric, {
				metricType: 'processing_latency',
				value: Math.round(avgLatency),
				windowStart,
				windowEnd: now,
			});
		}

		// Error rate: failed / total. Count both the retryable `failed` state and
		// its terminal twin `abandoned` (retries exhausted) — both are failures
		// from the health signal's perspective; the split is a retry-scheduling
		// concern, not an error-vs-success one.
		const totalActions = actions.length;
		const failedActions = actions.filter(
			(a) => a.status === 'failed' || a.status === 'abandoned',
		).length;
		const errorRate = totalActions > 0 ? failedActions / totalActions : 0;

		await ctx.runMutation(internal.agentHealth.recordMetric, {
			metricType: 'error_rate',
			value: errorRate,
			windowStart,
			windowEnd: now,
		});

		// Confidence degradation: fraction of recent classifications whose
		// confidence fell below 0.5. A spike here means the model is unsure
		// far more often than usual — a signal to stop auto-approving.
		let lowConfidence = 0;
		let scoredClassifications = 0;
		let confidenceSum = 0;
		let routedTotal = 0;
		let autoApproved = 0;
		let costTotalUsd = 0;
		for (const a of actions) {
			costTotalUsd += estimateCostUsd(a.modelUsed, a.tokenUsage);
			if (!a.output) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(a.output);
			} catch {
				continue;
			}
			if (a.actionType === 'classify' && parsed && typeof parsed === 'object' && 'confidence' in parsed) {
				const c = (parsed as { confidence?: unknown }).confidence;
				if (typeof c === 'number') {
					scoredClassifications++;
					confidenceSum += c;
					if (c < 0.5) lowConfidence++;
				}
			}
			if (a.actionType === 'route' && parsed && typeof parsed === 'object' && 'decision' in parsed) {
				routedTotal++;
				if ((parsed as { decision?: unknown }).decision === 'auto_approve') autoApproved++;
			}
		}
		const confidenceDegradation = scoredClassifications > 0 ? lowConfidence / scoredClassifications : 0;
		// Classification accuracy proxy: the mean self-reported confidence of
		// this window's `classify` actions. There is no human ground-truth label
		// stream, so this records the model's own confidence (0..1) as the best
		// available quality signal — the inverse view of confidence_degradation.
		const classificationAccuracy = scoredClassifications > 0 ? confidenceSum / scoredClassifications : 0;
		const autoApproveRatio = routedTotal > 0 ? autoApproved / routedTotal : 0;

		// Rejection rate from the human verification queue (last 24h, the
		// window the rejection_spike breaker reacts to).
		const feedback = await ctx.runQuery(internal.autonomy.getFeedbackCountsInternal, {
			since: now - 24 * 60 * 60 * 1000,
		});
		// Decisions-only denominator: an edit-then-approve records both an
		// `edited` and an `approved` row, so counting `edited` in the
		// denominator would deflate the rejection rate and trip the breaker
		// late. The rate is rejections / (approvals + rejections).
		const decisions = feedback.approved + feedback.rejected;
		const rejectionRate = decisions > 0 ? feedback.rejected / decisions : 0;

		// Record the previously-reserved metric types so their dashboard cards
		// stop reading zero.
		await ctx.runMutation(internal.agentHealth.recordMetric, {
			metricType: 'classification_accuracy',
			value: classificationAccuracy,
			windowStart,
			windowEnd: now,
		});
		await ctx.runMutation(internal.agentHealth.recordMetric, {
			metricType: 'auto_approve_ratio',
			value: autoApproveRatio,
			windowStart,
			windowEnd: now,
		});
		await ctx.runMutation(internal.agentHealth.recordMetric, {
			metricType: 'rejection_rate',
			value: rejectionRate,
			windowStart,
			windowEnd: now,
		});
		// Real estimated dollars (priced per model via lib/llm/pricing), not a raw
		// token count — the dashboard renders this with a "$".
		await ctx.runMutation(internal.agentHealth.recordMetric, {
			metricType: 'llm_cost',
			value: costTotalUsd,
			windowStart,
			windowEnd: now,
		});

		// Evaluate all three circuit breakers off this window's signals.
		await evaluateCircuitBreakers(ctx, {
			llm_failure: errorRate,
			confidence_degradation: confidenceDegradation,
			rejection_spike: rejectionRate,
		});

		// Cleanup old metrics periodically
		if (Math.random() < 0.05) { // ~5% chance each run
			await ctx.runMutation(internal.agentHealth.cleanupOldMetrics);
		}
	},
});

// ============================================================
// Helper Queries (internal)
// ============================================================

export const getRecentActions = internalQuery({
	args: { since: v.number() },
	handler: async (ctx, args) => {
		// Time-bounded but capped at the most-recent N (siblings getCostByStep /
		// getAccuracyTrend already cap): agentActions writes ~5-6 rows per inbound
		// message, so an inbound burst could put tens of thousands in the window and
		// overflow the rollup's read/memory budget. The rollup is an approximate
		// sampled health signal, so the most-recent N stays representative.
		return await ctx.db
			.query('agentActions')
			.withIndex('by_creation_time', (q) => q.gte('_creationTime', args.since))
			.order('desc')
			.take(5000);
	},
});

export const getPendingCount = internalQuery({
	args: {},
	handler: async (ctx) => {
		const pending = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'received'))
			.take(1000);
		return pending.length;
	},
});

// ============================================================
// Circuit Breaker Evaluation
// ============================================================

type BreakerType = 'llm_failure' | 'confidence_degradation' | 'rejection_spike';

/**
 * Evaluate every circuit breaker off the current window's signals. Each
 * breaker follows the same hysteresis state machine: when its value exceeds
 * the breaker's threshold it trips `open`; once the value recovers it steps
 * `open → half_open → closed` across successive rollups, confirming recovery
 * before auto-approval resumes. The `route` step refuses to auto-approve while
 * ANY breaker is open.
 */
async function evaluateCircuitBreakers(ctx: ActionCtx, values: Record<BreakerType, number>) {
	const breakers = await ctx.runQuery(internal.agentHealth.getCircuitBreakersInternal);
	const byType = new Map(breakers.map((b) => [b.breakerType, b]));

	for (const breakerType of Object.keys(values) as BreakerType[]) {
		const value = values[breakerType];
		const threshold = getDefaultThreshold(breakerType);
		const current = byType.get(breakerType);

		if (value > threshold) {
			// Tripped (or stays tripped).
			await ctx.runMutation(internal.agentHealth.updateCircuitBreaker, {
				breakerType,
				state: 'open' as const,
				currentValue: value,
			});
		} else if (current?.state === 'open') {
			// Value recovered — step to half_open to confirm.
			await ctx.runMutation(internal.agentHealth.updateCircuitBreaker, {
				breakerType,
				state: 'half_open' as const,
				currentValue: value,
			});
		} else if (current?.state === 'half_open') {
			// Sustained recovery — close it.
			await ctx.runMutation(internal.agentHealth.updateCircuitBreaker, {
				breakerType,
				state: 'closed' as const,
				currentValue: value,
			});
		}
	}
}

function getDefaultThreshold(breakerType: string): number {
	switch (breakerType) {
		case 'llm_failure': return 0.20;
		case 'confidence_degradation': return 0.30;
		case 'rejection_spike': return 0.40;
		default: return 0.25;
	}
}
