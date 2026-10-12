/**
 * Decision plane: the retry, fallback and backoff rules of the dispatch
 * (`./dispatch.ts`, which re-exports every name here). Split out to hold the
 * dispatch under the size cap. Runtime-neutral.
 */

import { errorStatus, isRetriableLlmError } from '../llm/retryPolicy';
import { admissionRefusalOf } from '../llm/admissionPort';
import { DecisionWireError } from '../decisionProviders/wire';
import {
	DecisionAccountingFailure,
	DecisionProviderUnavailable,
	DecisionRateLimitRefusal,
} from './contract';

/**
 * The backoff curve and the two bounds around a `Retry-After`: a small first step
 * (this plane is sold on sub-second answers), a cap before jitter, a spread so a
 * rate-limited fleet does not come back in lockstep, and the longest wait we will
 * hold a surface open for — past that the vendor is naming a time the caller
 * cannot afford, and coming back sooner is the storm the header exists to stop.
 */
export const DECISION_BACKOFF_BASE_MS = 250;
export const MAX_DECISION_BACKOFF_MS = 4_000;
export const RETRY_AFTER_JITTER_MS = 1_000;
export const MAX_HONOURED_RETRY_AFTER_MS = 20_000;

/**
 * Statuses that must never produce a fallback hop. A wrong or expired key
 * (401/403) and a question set the provider rejects (422) are OUR config or OUR
 * bug; answering them on the language plane would hide the mistake for as long as
 * the deployment runs, and pay the cost difference to do it. They are not
 * retriable either — this list is only about the hop.
 */
export const NO_FALLBACK_STATUSES: readonly number[] = [401, 403, 422];

/** Best-effort `Retry-After` off an adapter error shape; the status reader is
 * `lib/llm/dispatch.ts`'s, imported rather than re-spelled. */
export function retryAfterOf(error: unknown): number | undefined {
	const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Whether an attempt is worth repeating. Three sources, in order: a codec refusal
 * never is (re-asking a provider that disagreed with our question set only spends
 * money to disagree again); an adapter's own `retriable` verdict wins where it
 * set one, since it knows a refused redirect from a timeout and neither has a
 * status; everything else goes to the repo's one classifier.
 */
export function isRetriableDecisionError(error: unknown): boolean {
	if (error instanceof DecisionAccountingFailure) return false;
	// Our own ceiling, not the provider's: the bucket a retry would charge is the
	// one that just said no, so a retry is three requests' worth of waiting for
	// the same answer.
	if (error instanceof DecisionRateLimitRefusal) return false;
	if (error instanceof DecisionWireError) return false;
	const stated = (error as { retriable?: unknown } | null)?.retriable;
	if (typeof stated === 'boolean') return stated;
	return isRetriableLlmError(error);
}

/**
 * Whether this failure may hop to the language plane. Narrower than "is not
 * retriable" on purpose: a hop is a spend decision, so anything pointing at our
 * own key, question set or codec stays an error the operator has to see.
 */
export function mayFallBack(error: unknown): boolean {
	if (error instanceof DecisionAccountingFailure) return false;
	// A refused call is not a failed provider. Hopping here would answer the
	// volume we just declined to serve on a model that costs 24 to 50 times more.
	if (error instanceof DecisionRateLimitRefusal) return false;
	if (error instanceof DecisionWireError) return false;
	// D3: a provider that cannot answer, or an exhausted spend cap, is terminal.
	if (error instanceof DecisionProviderUnavailable) return false;
	if (admissionRefusalOf(error)) return false;
	const status = errorStatus(error);
	return status === undefined || !NO_FALLBACK_STATUSES.includes(status);
}

// ─── Timing ────────────────────────────────────────────────────────────────

/**
 * How long before the next attempt.
 *
 * Our own curve is exponential, capped, and EQUAL-JITTERED: half the computed
 * delay is a floor and the other half is spread. The floor keeps a struggling
 * upstream from being hit again immediately, the spread stops a batch of
 * messages that arrived together from retrying together, and unlike full jitter
 * it cannot collapse a whole fleet back onto ~0 ms.
 *
 * A `Retry-After` replaces that curve outright — only the vendor knows when its
 * bucket refills — and is spread UPWARD only, since coming back before the time
 * we were given is worse than useless. Undefined means the wait is longer than
 * a surface can be held open for.
 */
export function backoffDelayMs(
	attemptIndex: number,
	retryAfterMs: number | undefined,
	random: () => number
): number | undefined {
	if (retryAfterMs !== undefined) {
		if (retryAfterMs > MAX_HONOURED_RETRY_AFTER_MS) return undefined;
		return Math.round(retryAfterMs + random() * RETRY_AFTER_JITTER_MS);
	}
	const curve = Math.min(DECISION_BACKOFF_BASE_MS * 2 ** attemptIndex, MAX_DECISION_BACKOFF_MS);
	return Math.round(curve / 2 + random() * (curve / 2));
}

/** The backoff wait, cancellable: a caller who gives up does not wait it out. */
export function realSleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
	if (!abortSignal) return new Promise((resolve) => setTimeout(resolve, ms));
	assertNotAborted(abortSignal);
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortSignal.reason ?? new Error('Decision dispatch aborted'));
		};
		const timer = setTimeout(() => {
			abortSignal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		abortSignal.addEventListener('abort', onAbort, { once: true });
	});
}

function assertNotAborted(abortSignal: AbortSignal | undefined): void {
	if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('Decision dispatch aborted');
}
