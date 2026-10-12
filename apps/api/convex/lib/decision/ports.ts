'use node';

/**
 * Decision plane — the ctx-bound ports.
 *
 * `runDecision` takes its rate limiter, its fallback breaker and its usage
 * recorder as injected ports (`lib/decision/contract.ts`) because each of them
 * needs a Convex ctx and the dispatch has no business holding one. This is the
 * one place those ports are built, so a call site writes three lines rather
 * than ten, and so the wiring that bounds the expensive fallback hop cannot be
 * half-remembered at the fourteenth call site.
 *
 * TWO READINGS OF THE RATE. `decisionPlaneGlobal` is charged once per LOGICAL
 * CALL, by `decision/gate.ts`, at admission. The {@link decisionRateLimiterPort}
 * charges `decisionPlaneAttempt` once per ATTEMPT, so retries and the fallback
 * hop each charge. The port alone does not see every paid request, though: the
 * language-backed adapter retries inside `runLlmObject`, so one of its attempts
 * can be three requests. Those requests are METERED instead, one ledger row
 * each (the recorder below), which is what the spend ceiling reads.
 *
 * Everything here runs from an ACTION: the breaker's budget is a rate-limiter
 * bucket (`internal.decision.breaker`) and the ledger row is a mutation
 * (`analytics/llmUsage.recordRequests`), and an action is the only ctx that can
 * reach both.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { resolveEndpointLocality } from '../llm/endpointLocality';
import { storeRequestBatch } from '../../analytics/meteredSpend';
import type {
	DecisionAttemptRecord,
	DecisionFallbackBreaker,
	DecisionRateLimiter,
	DecisionUsageRecorder,
} from './contract';

/**
 * The breaker as the dispatch reads it. `isOpen` is a QUERY (it charges
 * nothing) and `recordFailure` a mutation that charges one token of the failure
 * budget; the budget's own refill is the recovery curve, so there is nothing to
 * report on success.
 */
export function decisionBreakerPort(ctx: ActionCtx): DecisionFallbackBreaker {
	return {
		isOpen: async () => !(await ctx.runQuery(internal.decision.breaker.status, {})).fallbackAllowed,
		recordFailure: async () => {
			await ctx.runMutation(internal.decision.breaker.recordFailure, {});
		},
	};
}

/**
 * One provider request → one `llmUsageEvents` row, tagged `decision`.
 *
 * An attempt hands over the requests it made (`DecisionAttemptRecord.requests`):
 * one for the native and local adapters, up to three for the language-backed
 * one. Each row carries its own usage; failed requests keep reported usage when
 * there was any and cost zero otherwise, because the plane's three counters are
 * about what it DID, and a ledger that only sees answers cannot show an outage.
 * The error itself is never persisted — only whether upstream was throttling —
 * because an adapter's message can quote a vendor body, and a ledger row is not
 * the place to find out that it once quoted a key.
 */
export function decisionUsageRecorder(ctx: ActionCtx): DecisionUsageRecorder {
	return async (record: DecisionAttemptRecord) => {
		if (record.requests.length === 0) return;
		// Retried, then scheduled: a transient failure must not lose billed rows.
		await storeRequestBatch(ctx, {
			feature: record.feature,
			plane: 'decision',
			requestId: record.requestId,
			isFallback: record.fallback,
			...(record.task ? { task: record.task } : {}),
			...(record.root?.rootRequestId ? { rootRequestId: record.root.rootRequestId } : {}),
			...(record.root?.parentCallId ? { parentCallId: record.root.parentCallId } : {}),
			...(record.calibrated === undefined ? {} : { isCalibrated: record.calibrated }),
			// From the adapter that ran, not the model id it reported: a local
			// engine may load any checkpoint, and every one of them is free. The
			// rule is the language and embedding planes' (`endpointLocality.ts`); a
			// language-backed request carries its own model's locality.
			...(resolveEndpointLocality(record.provider, undefined) === 'local'
				? { isLocalEngine: true }
				: {}),
			requests: record.requests.map(({ outcome: _outcome, ...request }) => request),
		});
	};
}

/**
 * The per-ATTEMPT limiter: one token of `decisionPlaneAttempt` per round trip
 * to a decision provider, keyed by provider kind (one upstream account each).
 * A refusal is wrapped by the dispatch in `DecisionRateLimitRefusal`: terminal,
 * never retried, never charged to the breaker, never a reason to hop.
 */
export function decisionRateLimiterPort(ctx: ActionCtx): DecisionRateLimiter {
	return {
		reserve: async (provider) => {
			await ctx.runMutation(internal.decision.gate.chargeDecisionAttempt, { provider });
		},
	};
}
