/**
 * Decision plane: the retry, fallback and backoff rules of the dispatch
 * (`./dispatch.ts`, which re-exports every name here). Split out to hold the
 * dispatch under the size cap. Runtime-neutral.
 */

import { nextDelay, type RetryPolicy } from '@owlat/shared/retryPolicy';
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

const DECISION_BACKOFF: RetryPolicy = {
	baseMs: DECISION_BACKOFF_BASE_MS,
	capMs: MAX_DECISION_BACKOFF_MS,
	jitter: { kind: 'equal' },
	round: true,
};

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
	// A provider that cannot answer, or an exhausted spend cap, is terminal.
	if (error instanceof DecisionProviderUnavailable) return false;
	if (admissionRefusalOf(error)) return false;
	return isOperationalFailure(error);
}

/**
 * Only a clearly OPERATIONAL failure of a working provider may
 * hop: a timeout, a 408 or 429, a 5xx, or a dropped connection. Everything
 * else is terminal, whatever its shape: a 4xx or a redirect (our key, our
 * request, our base URL), a guard or configuration refusal without a status,
 * an unreachable or unresolvable host, and anything unrecognized. A hop is a
 * paid language call; an error nobody can classify does not buy one.
 */
export function isOperationalFailure(error: unknown): boolean {
	const status = errorStatus(error);
	if (status !== undefined) {
		return (
			!NO_FALLBACK_STATUSES.includes(status) && (status === 408 || status === 429 || status >= 500)
		);
	}
	// No status: an adapter's transport failure. Look through it to what failed.
	for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
		if (isTimeout(current) || isConnectionReset(current)) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** Codes of a connection that was established, or being established, and dropped or timed out. */
const RESET_CODES: ReadonlySet<string> = new Set([
	'ECONNRESET',
	'ECONNABORTED',
	'EPIPE',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'UND_ERR_SOCKET',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
]);

function isTimeout(error: unknown): boolean {
	return error instanceof Error && error.name === 'TimeoutError';
}

function isConnectionReset(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && RESET_CODES.has(code);
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
	return nextDelay(DECISION_BACKOFF, attemptIndex, undefined, random);
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
