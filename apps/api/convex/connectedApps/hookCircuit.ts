/**
 * Circuit breaker for signed synchronous hooks (Tier 2). PURE state machine: no
 * Convex, no Node, no clock of its own — the caller supplies `now` and persists
 * the returned state. Keeping it pure makes every transition unit-testable with
 * a deterministic clock.
 *
 * A repeatedly-failing connected app must not be probed on the hot path of every
 * decision: each failed hook still costs a full guarded fetch and its timeout.
 * The breaker short-circuits to the declared fallback while the endpoint is
 * unhealthy, then lets a single trial through to see if it recovered.
 *
 *   CLOSED    — calls flow; each consecutive failure increments the counter.
 *   OPEN      — the counter reached the threshold; `openedUntil` is set. While
 *               `now < openedUntil`, calls are short-circuited (no fetch).
 *   HALF-OPEN — once `now >= openedUntil`, ONE trial call is allowed. A success
 *               closes the breaker (counter resets); a failure re-opens it for a
 *               fresh cooldown.
 *
 * This never changes a decision's SAFETY — an open breaker means the caller
 * applies the SAME declared fallback it would apply on a live failure (a gate
 * still fails closed to caution). It only avoids paying for a doomed request.
 */

/** Persisted breaker state for one (app, hookKind). */
export interface HookCircuitState {
	/** Consecutive failures since the last success. */
	readonly consecutiveFailures: number;
	/** When set and in the future, the breaker is open until this epoch-ms. */
	readonly openedUntil?: number;
}

export interface HookCircuitConfig {
	/** Consecutive failures that trip the breaker OPEN. Must be >= 1. */
	readonly failureThreshold: number;
	/** How long the breaker stays open before a half-open trial, in ms. */
	readonly cooldownMs: number;
}

/** The neutral starting state: closed, no failures. */
export const INITIAL_HOOK_CIRCUIT_STATE: HookCircuitState = Object.freeze({
	consecutiveFailures: 0,
});

/**
 * Whether a call must be short-circuited right now. `true` only while the
 * breaker is OPEN and the cooldown has not elapsed; at/after `openedUntil` it is
 * half-open and returns `false` so exactly the next call becomes the trial.
 */
export function isHookCircuitOpen(state: HookCircuitState, now: number): boolean {
	return state.openedUntil !== undefined && now < state.openedUntil;
}

/** Fold a successful outcome in: the breaker fully closes and the counter resets. */
export function recordHookSuccess(): HookCircuitState {
	return INITIAL_HOOK_CIRCUIT_STATE;
}

/**
 * Fold a failed outcome in. Increments the consecutive-failure counter; once it
 * reaches the threshold the breaker opens for a fresh cooldown window (a
 * half-open trial that fails re-opens it, because that trial's failure is what
 * pushes the counter back to the threshold).
 */
export function recordHookFailure(
	state: HookCircuitState,
	now: number,
	config: HookCircuitConfig
): HookCircuitState {
	const threshold = Math.max(1, Math.trunc(config.failureThreshold));
	const consecutiveFailures = state.consecutiveFailures + 1;
	if (consecutiveFailures >= threshold) {
		return Object.freeze({
			consecutiveFailures,
			openedUntil: now + Math.max(0, config.cooldownMs),
		});
	}
	return Object.freeze({ consecutiveFailures });
}
