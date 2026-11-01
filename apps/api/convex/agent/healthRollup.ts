/**
 * Agent health rollup: every five minutes (cron) `rollupMetrics` turns the
 * recent pipeline activity into `agentMetrics` data points and moves the
 * circuit breakers, following the circuit breaker pattern from the MTA.
 * `agent/health.ts` serves what this writes to the dashboard and the route step.
 *
 * Each builder's body is an exported helper so the previous-release shims at
 * the old root path (`agentHealth.ts`) run the same code.
 */

import { v, type Infer } from 'convex/values';
import {
	internalQuery,
	internalAction,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { estimateCostUsd } from '../lib/llm/pricing';
import { agentMetricTypeValidator } from '../lib/literalValidators';

// ============================================================
// Internal Mutations
// ============================================================

/** One rollup data point, before it is stamped with `createdAt`. */
export const agentMetricRowValidator = v.object({
	metricType: agentMetricTypeValidator,
	value: v.number(),
	windowStart: v.number(),
	windowEnd: v.number(),
});

type AgentMetricRow = Infer<typeof agentMetricRowValidator>;

export const breakerTypeValidator = v.union(
	v.literal('llm_failure'),
	v.literal('confidence_degradation'),
	v.literal('rejection_spike')
);
type BreakerType = Infer<typeof breakerTypeValidator>;

/**
 * The one commit of `rollupMetrics`: the window's data points and the circuit
 * breakers its signals move, in ONE transaction.
 *
 * One window is one observation: writing its points through separate
 * mutations meant as many transactions (and OCC write conflicts on
 * `agentMetrics`) per tick, and a failure partway through left a half-written
 * window on the dashboard — an error_rate with no llm_cost beside it, which
 * reads as "the pipeline was cheap and broken" rather than "the rollup died".
 * The breakers are read here, in the same transaction that moves them, so a
 * step `open → half_open → closed` is always taken from the state it stands on.
 */
export const commitRollup = internalMutation({
	args: {
		metrics: v.array(agentMetricRowValidator),
		signals: v.object({
			llm_failure: v.number(),
			confidence_degradation: v.number(),
			rejection_spike: v.number(),
		}),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await insertMetrics(ctx, args.metrics);
		await applyBreakerSignals(ctx, args.signals);
		return null;
	},
});

export async function insertMetrics(ctx: MutationCtx, metrics: AgentMetricRow[]): Promise<void> {
	const createdAt = Date.now();
	for (const metric of metrics) {
		await ctx.db.insert('agentMetrics', { ...metric, createdAt });
	}
}

/** Set a breaker's state and value, stamping the moment it trips or recovers. */
export async function writeCircuitBreaker(
	ctx: MutationCtx,
	existing: Doc<'agentCircuitBreakers'> | null | undefined,
	breakerType: BreakerType,
	state: Doc<'agentCircuitBreakers'>['state'],
	currentValue: number
): Promise<void> {
	const now = Date.now();
	if (existing) {
		const patch: Partial<Doc<'agentCircuitBreakers'>> = { state, currentValue };
		if (state === 'open' && existing.state !== 'open') {
			patch.trippedAt = now;
		}
		if (state === 'closed' && existing.state !== 'closed') {
			patch.recoveredAt = now;
		}
		await ctx.db.patch(existing._id, patch);
		return;
	}
	await ctx.db.insert('agentCircuitBreakers', {
		breakerType,
		state,
		threshold: getDefaultThreshold(breakerType),
		currentValue,
		createdAt: now,
	});
}

// ============================================================
// Internal Action: Metrics Rollup (called by cron)
// ============================================================

/**
 * Compute and record metrics from recent pipeline activity.
 * Called every 5 minutes by cron.
 *
 * Stays an ACTION rather than collapsing into one read-and-write mutation: the
 * window is computed off a 5000-row `agentActions` scan and a 1000-row
 * `inboundMessages` scan, and holding that much of the pipeline's hottest table
 * inside a write transaction would make the rollup conflict with the very
 * pipeline it measures. The reads are snapshot-consistent per query and the
 * WRITE — the part that has to be all-or-nothing — is one transaction.
 */
export const rollupMetrics = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => await runRollup(ctx),
});

export async function runRollup(ctx: ActionCtx): Promise<null> {
	const now = Date.now();
	const windowStart = now - 5 * 60 * 1000;

	// Every point this window produces, collected first and written once at
	// the end — see `commitRollup` for why the window is one transaction.
	const metrics: AgentMetricRow[] = [];
	const record = (metricType: AgentMetricRow['metricType'], value: number) => {
		metrics.push({ metricType, value, windowStart, windowEnd: now });
	};

	// Get recent agent actions for this window
	const actions = await ctx.runQuery(internal.agent.healthRollup.getRecentActions, {
		since: windowStart,
	});

	// Queue depth: count pending messages
	const queueDepth = await ctx.runQuery(internal.agent.healthRollup.getPendingCount);
	record('queue_depth', queueDepth);

	// Processing latency: average duration of completed actions
	const completedActions = actions.filter((a) => a.status === 'completed' && a.durationMs);
	if (completedActions.length > 0) {
		const avgLatency =
			completedActions.reduce((sum, a) => sum + (a.durationMs ?? 0), 0) / completedActions.length;
		record('processing_latency', Math.round(avgLatency));
	}

	// Error rate: failed / total. Count both the retryable `failed` state and
	// its terminal twin `abandoned` (retries exhausted) — both are failures
	// from the health signal's perspective; the split is a retry-scheduling
	// concern, not an error-vs-success one.
	const totalActions = actions.length;
	const failedActions = actions.filter(
		(a) => a.status === 'failed' || a.status === 'abandoned'
	).length;
	const errorRate = totalActions > 0 ? failedActions / totalActions : 0;
	record('error_rate', errorRate);

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
		if (
			a.actionType === 'classify' &&
			parsed &&
			typeof parsed === 'object' &&
			'confidence' in parsed
		) {
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
	const confidenceDegradation =
		scoredClassifications > 0 ? lowConfidence / scoredClassifications : 0;
	// Classification accuracy proxy: the mean self-reported confidence of
	// this window's `classify` actions. There is no human ground-truth label
	// stream, so this records the model's own confidence (0..1) as the best
	// available quality signal — the inverse view of confidence_degradation.
	const classificationAccuracy =
		scoredClassifications > 0 ? confidenceSum / scoredClassifications : 0;
	const autoApproveRatio = routedTotal > 0 ? autoApproved / routedTotal : 0;

	// Rejection rate from the human verification queue (last 24h, the
	// window the rejection_spike breaker reacts to).
	const feedback = await ctx.runQuery(internal.autonomy.feedback.getFeedbackCountsInternal, {
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
	record('classification_accuracy', classificationAccuracy);
	record('auto_approve_ratio', autoApproveRatio);
	record('rejection_rate', rejectionRate);
	// Real estimated dollars (priced per model via lib/llm/pricing), not a raw
	// token count — the dashboard renders this with a "$".
	record('llm_cost', costTotalUsd);

	// The window and the three circuit breakers its signals move, in one commit.
	await ctx.runMutation(internal.agent.healthRollup.commitRollup, {
		metrics,
		signals: {
			llm_failure: errorRate,
			confidence_degradation: confidenceDegradation,
			rejection_spike: rejectionRate,
		},
	});
	return null;
}

// ============================================================
// Helper Queries (internal)
// ============================================================

export const getRecentActions = internalQuery({
	args: { since: v.number() },
	handler: async (ctx, args) => await readRecentActions(ctx, args),
});

export async function readRecentActions(ctx: QueryCtx, args: { since: number }) {
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
}

export const getPendingCount = internalQuery({
	args: {},
	handler: async (ctx) => await countPendingMessages(ctx),
});

export async function countPendingMessages(ctx: QueryCtx): Promise<number> {
	const pending = await ctx.db
		.query('inboundMessages')
		.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'received'))
		.take(1000);
	return pending.length;
}

// ============================================================
// Circuit Breaker Evaluation
// ============================================================

/**
 * Evaluate every circuit breaker off the current window's signals. Each
 * breaker follows the same hysteresis state machine: when its value exceeds
 * the breaker's threshold it trips `open`; once the value recovers it steps
 * `open → half_open → closed` across successive rollups, confirming recovery
 * before auto-approval resumes. The `route` step refuses to auto-approve while
 * ANY breaker is open.
 */
async function applyBreakerSignals(ctx: MutationCtx, values: Record<BreakerType, number>) {
	const breakers = await ctx.db.query('agentCircuitBreakers').collect(); // bounded: fixed small set of breaker types
	const byType = new Map(breakers.map((b) => [b.breakerType, b]));

	for (const breakerType of Object.keys(values) as BreakerType[]) {
		const value = values[breakerType];
		const current = byType.get(breakerType);

		if (value > getDefaultThreshold(breakerType)) {
			// Tripped (or stays tripped).
			await writeCircuitBreaker(ctx, current, breakerType, 'open', value);
		} else if (current?.state === 'open') {
			// Value recovered — step to half_open to confirm.
			await writeCircuitBreaker(ctx, current, breakerType, 'half_open', value);
		} else if (current?.state === 'half_open') {
			// Sustained recovery — close it.
			await writeCircuitBreaker(ctx, current, breakerType, 'closed', value);
		}
	}
}

function getDefaultThreshold(breakerType: string): number {
	switch (breakerType) {
		case 'llm_failure':
			return 0.2;
		case 'confidence_degradation':
			return 0.3;
		case 'rejection_spike':
			return 0.4;
		default:
			return 0.25;
	}
}
