/**
 * The one exponential backoff curve.
 *
 * Every retry or reconnect wait that grows by a constant factor is computed
 * here, from a {@link RetryPolicy} its owner declares once. The owner keeps
 * everything else: what counts as retryable, where the attempt count lives,
 * deadlines, cancellation and scheduling. Only the arithmetic is shared, so
 * that a policy's numbers and its indexing are stated in one place and pinned
 * by tests, instead of being re-derived as `base * 2 ** (n - 1)` at every call
 * site with its own idea of where `n` starts. The `owlat/no-inline-backoff`
 * lint rule keeps new exponential backoff out of every other file.
 *
 * Indexing is zero-based: `attemptIndex` 0 is the wait before the FIRST retry,
 * i.e. after one failed run. A caller that counts failures (1, 2, …) passes
 * `failures - 1`; a caller that counts retries already made passes that count.
 * An index below zero counts as zero.
 *
 * Timing on delivery paths is behaviour: a policy's values are its owner's
 * contract with the systems it retries against, so changing one is a
 * behaviour change, never a refactor.
 *
 * Browser-safe and dependency-free (the web app, the Convex backend and every
 * Node sidecar import it). Exposed through the `@owlat/shared/retryPolicy`
 * subpath only.
 */

/**
 * Spread added to the capped curve so that callers which failed together do
 * not retry together. Jitter is applied after the cap, so a jittered delay may
 * exceed `capMs`.
 *
 * - `equal`: half the delay is a floor, the other half is spread uniformly
 *   (`d/2 + r·d/2`). It cannot collapse a fleet back onto ~0 ms.
 * - `spread`: the delay scaled into `[1 − ratio, 1 + ratio)`.
 * - `upTo`: up to `ratio` of the delay added on top, in whole milliseconds.
 * - `fixed`: up to `maxMs` added on top, in whole milliseconds.
 */
export type RetryJitter =
	| { readonly kind: 'equal' }
	| { readonly kind: 'spread'; readonly ratio: number }
	| { readonly kind: 'upTo'; readonly ratio: number }
	| { readonly kind: 'fixed'; readonly maxMs: number };

export interface RetryPolicy {
	/** The wait before the first retry (attempt index 0), in milliseconds. */
	readonly baseMs: number;
	/** Growth per retry. Defaults to 2. */
	readonly factor?: number;
	/** The longest wait the curve reaches before jitter. Omitted: uncapped. */
	readonly capMs?: number;
	/**
	 * Total runs, the first one included. Omitted when the owner bounds its
	 * retries some other way (a deadline, a budget it computes per call).
	 */
	readonly maxAttempts?: number;
	/** Omitted: no jitter. */
	readonly jitter?: RetryJitter;
	/** Round the jittered delay to the nearest millisecond. */
	readonly round?: boolean;
}

/**
 * The wait before retry `attemptIndex` (zero-based, see the module comment):
 * `baseMs · factor^attemptIndex`, capped at `capMs`, then jittered, then
 * rounded. A `retryAfterMs` hint (a server's `Retry-After`) is a floor applied
 * last: the result is never shorter than the time the server asked for.
 * `random` returns a value in `[0, 1)`; inject it to make jitter deterministic.
 */
export function nextDelay(
	policy: RetryPolicy,
	attemptIndex: number,
	retryAfterMs?: number,
	random: () => number = Math.random
): number {
	const index = Math.max(0, attemptIndex);
	const curve = policy.baseMs * (policy.factor ?? 2) ** index;
	const capped = policy.capMs === undefined ? curve : Math.min(curve, policy.capMs);
	const jittered = applyJitter(capped, policy.jitter, random);
	const delay = policy.round ? Math.round(jittered) : jittered;
	return retryAfterMs === undefined ? delay : Math.max(delay, retryAfterMs);
}

/**
 * Whether another run is allowed after `attemptsMade` runs (the first one
 * included). Always true for a policy without `maxAttempts`.
 */
export function canRetry(policy: RetryPolicy, attemptsMade: number): boolean {
	return policy.maxAttempts === undefined || attemptsMade < policy.maxAttempts;
}

function applyJitter(delay: number, jitter: RetryJitter | undefined, random: () => number): number {
	switch (jitter?.kind) {
		case undefined:
			return delay;
		case 'equal':
			return delay / 2 + random() * (delay / 2);
		case 'spread':
			return delay * (1 - jitter.ratio + random() * (2 * jitter.ratio));
		case 'upTo':
			return delay + Math.floor(random() * (delay * jitter.ratio));
		case 'fixed':
			return delay + Math.floor(random() * jitter.maxMs);
	}
}
