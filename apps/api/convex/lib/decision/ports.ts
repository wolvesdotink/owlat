'use node';

/**
 * Decision plane — the ctx-bound ports.
 *
 * `runDecision` takes its rate limiter, its fallback breaker and its usage
 * recorder as injected ports (`lib/decision/contract.ts`) because each of them
 * needs a Convex ctx and the dispatch has no business holding one. This is the
 * one place those ports are built, so a call site writes two lines rather than
 * six, and so the wiring that bounds the expensive fallback hop cannot be
 * half-remembered at the fourteenth call site.
 *
 * TWO OF THE THREE, and the third is named here rather than quietly missing.
 * `decisionPlaneGlobal` is charged once per LOGICAL CALL, by `decision/gate.ts`,
 * at admission — which is the only reading an action can take, since the bucket
 * needs a mutation ctx and the gate is already one. The dispatch's
 * `DecisionRateLimiter` port meters per ATTEMPT instead, so retries and the
 * fallback hop each charge, and no ctx-bound implementation of it is built yet:
 * it would need a second internal mutation on the request path, and with no call
 * site on the plane there is nothing retrying to meter. The first migrated call
 * site brings it, and until then the gate's per-call charge is what bounds the
 * plane. Stated here because an unbuilt port reads exactly like a forgotten one.
 *
 * Everything here runs from an ACTION: the breaker's budget is a rate-limiter
 * bucket (`internal.decision.breaker`) and the ledger row is a mutation
 * (`analytics/llmUsage.recordDecisionSpend`), and an action is the only ctx that
 * can reach both.
 */

import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { recordDecisionSpend } from '../../analytics/llmUsage';
import { errorStatus } from '../llm/dispatch';
import type {
	DecisionAttemptRecord,
	DecisionFallbackBreaker,
	DecisionUsageRecorder,
} from './contract';

/** Upstream pushing back: 429, and 529 — the overload code their API uses. */
const THROTTLED_STATUSES: readonly number[] = [429, 529];

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
 * One attempt → one `llmUsageEvents` row, tagged `decision`.
 *
 * Failed attempts retain reported usage when available; otherwise cost is zero: the plane's three counters are
 * about what it DID, and a ledger that only sees answers cannot show an outage.
 * The error itself is never persisted — only whether upstream was throttling —
 * because an adapter's message can quote a vendor body, and a ledger row is not
 * the place to find out that it once quoted a key.
 */
export function decisionUsageRecorder(ctx: ActionCtx): DecisionUsageRecorder {
	return async (record: DecisionAttemptRecord) => {
		const status = record.outcome === 'failed' ? errorStatus(record.error) : undefined;
		await recordDecisionSpend(ctx, record.feature, record.usage, record.modelUsed, {
			requestId: record.requestId,
			isFallback: record.fallback,
			...(record.calibrated === undefined ? {} : { isCalibrated: record.calibrated }),
			...(status !== undefined ? { isThrottled: THROTTLED_STATUSES.includes(status) } : {}),
		});
	};
}
