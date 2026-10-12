/**
 * Decision plane — which provider requests one attempt made (ADR-0073).
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
import type { LlmCallMeter, LlmRequestInput, LlmRequestRecord } from '../llm/requestMeter';

/** Upstream pushing back: 429, and 529 — the overload code their API uses. */
export const THROTTLED_STATUSES: readonly number[] = [429, 529];

export function isThrottledError(error: unknown): boolean {
	const status = errorStatus(error);
	return status !== undefined && THROTTLED_STATUSES.includes(status);
}

/**
 * The provider requests one attempt made. An adapter that metered its own
 * (the language-backed one, which retries inside `runLlmObject`) left them on
 * the meter; for any other adapter the attempt was one request, recorded here
 * from what the attempt returned. A throttled failure marks its last request.
 */
export function attemptRequests(
	meter: LlmCallMeter,
	recordedBefore: number,
	single: Omit<LlmRequestInput, 'latencyMs'>,
	durationMs: number,
	error?: unknown
): LlmRequestRecord[] {
	if (meter.requests.length === recordedBefore) meter.record({ ...single, latencyMs: durationMs });
	const requests = meter.takeUnwritten();
	if (error === undefined || !isThrottledError(error) || requests.length === 0) return requests;
	const last = requests.length - 1;
	return requests.map((request, index) =>
		index === last ? { ...request, isThrottled: true } : request
	);
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
