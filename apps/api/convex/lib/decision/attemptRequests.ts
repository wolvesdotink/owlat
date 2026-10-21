/**
 * Decision plane — which provider requests one attempt made, and the root
 * deadline every attempt runs under.
 *
 * The ledger holds one row per provider request. A decision attempt is one
 * request for the native and local adapters, but the language-backed adapter
 * retries inside `runLlmObject`, so one of its attempts can be up to three
 * billed requests; it records them on the decision's meter itself. Split out
 * of `./dispatch.ts` for size; pure.
 */

import type { TokenUsage } from '../../agent/steps/types';
import { DecisionWireError } from '../decisionProviders/wire';
import { partialUsageOf } from '../llm/partialUsage';
import { errorStatus } from '../llm/retryPolicy';
import { callSignal } from '../llm/taskLimits';
import { resolveEndpointLocality } from '../llm/endpointLocality';
import type { QuestionSet } from './questions';
import type { RunDecisionOptions } from './contract';
import type { LlmCallMeter, LlmRequestInput, LlmRequestRecord } from '../llm/requestMeter';

/** Upstream pushing back: 429, and 529 — the overload code their API uses. */
export const THROTTLED_STATUSES: readonly number[] = [429, 529];

export function isThrottledError(error: unknown): boolean {
	const status = errorStatus(error);
	return status !== undefined && THROTTLED_STATUSES.includes(status);
}

/**
 * The provider requests one attempt made, not yet stored. An adapter that
 * metered its own (the language-backed one, which retries inside
 * `runLlmObject`) left them on the meter; for any other adapter the attempt
 * was one request, recorded here from what the attempt returned. A throttled
 * failure marks its last request. Nothing is acknowledged here: the dispatch
 * acknowledges the requests once the recorder has stored them, so a failed
 * write leaves them for the next attempt's row write.
 */
export function attemptRequests(
	meter: LlmCallMeter,
	recordedBefore: number,
	single: Omit<LlmRequestInput, 'latencyMs'>,
	durationMs: number,
	error?: unknown,
	attemptTags: AttemptTags = {}
): LlmRequestRecord[] {
	if (meter.requests.length === recordedBefore) meter.record({ ...single, latencyMs: durationMs });
	// THIS attempt's requests carry its own tags, so a request an earlier write
	// left pending keeps the tags of the attempt that made it.
	for (let attempt = recordedBefore + 1; attempt <= meter.requests.length; attempt++) {
		meter.amend(attempt, attemptTags);
	}
	if (error !== undefined && isThrottledError(error)) {
		meter.amend(meter.requests.length, { isThrottled: true });
	}
	return meter.pendingWrites();
}

/** The per-attempt tags every request of the attempt carries. */
export interface AttemptTags {
	readonly isFallback?: boolean;
	readonly isCalibrated?: boolean;
	readonly isLocalEngine?: boolean;
}

/**
 * What a failed attempt was billed for: a response the codec rejected
 * (`DecisionWireError`), or a language call whose billed completions never
 * fitted the schema (`LlmPartialUsageError`, #1260). Anything else bills
 * nothing we can see.
 */
export function billedUsage(error: unknown): { usage?: TokenUsage; modelUsed?: string } {
	if (error instanceof DecisionWireError) return { usage: error.usage, modelUsed: error.modelUsed };
	const partial = partialUsageOf(error);
	return partial ? { usage: partial.tokenUsage, modelUsed: partial.modelUsed } : {};
}

/** `options` with the root's remaining time joined to its abort signal. */
export function withRootDeadline<Q extends QuestionSet>(
	options: RunDecisionOptions<Q>
): RunDecisionOptions<Q> {
	const deadlineAt = options.root?.deadlineAt;
	if (deadlineAt === undefined) return options;
	const signal = callSignal(options.abortSignal, Math.max(0, deadlineAt - Date.now()));
	return signal ? { ...options, abortSignal: signal } : options;
}

/** An adapter deadline never past the root's: the request must end in time to be recorded. */
export function withinRoot(
	deadlineMs: number,
	root: RunDecisionOptions<QuestionSet>['root']
): number {
	if (root?.deadlineAt === undefined) return deadlineMs;
	return Math.max(0, Math.min(deadlineMs, root.deadlineAt - Date.now()));
}

/** A request on the operator's own engine costs nothing (`lib/llm/endpointLocality.ts`). */
export function localTag(provider: { readonly kind: string }): { isLocalEngine?: true } {
	return resolveEndpointLocality(provider.kind, undefined) === 'local'
		? { isLocalEngine: true }
		: {};
}
