/**
 * A minimal circuit breaker for synchronous hook endpoints. It is an
 * *availability* protection, not a security control: it stops Owlat from
 * hammering (and blocking decision points on) an endpoint that is failing, by
 * short-circuiting straight to the declared fallback once failures pile up.
 *
 * Pure and clock-injected: no timers, no `Date.now()`. The host supplies the
 * current time so tests are deterministic. State is small and serializable so a
 * durable store (PP-25) can persist it later; the default store is in-memory.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
	/** Consecutive failures that trip the breaker from closed to open. */
	readonly failureThreshold: number;
	/** How long the breaker stays open before allowing a half-open probe. */
	readonly cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = Object.freeze({
	failureThreshold: 5,
	cooldownMs: 30_000,
});

/** Serializable per-endpoint breaker record. */
export interface CircuitBreakerRecord {
	readonly consecutiveFailures: number;
	readonly openedAt: number | null;
}

const CLOSED_RECORD: CircuitBreakerRecord = Object.freeze({
	consecutiveFailures: 0,
	openedAt: null,
});

/** Storage seam: load/save a breaker record by hook id. In-memory by default. */
export interface CircuitBreakerStore {
	load(hookId: string): CircuitBreakerRecord | undefined;
	save(hookId: string, record: CircuitBreakerRecord): void;
}

export function createInMemoryCircuitBreakerStore(): CircuitBreakerStore {
	const records = new Map<string, CircuitBreakerRecord>();
	return {
		load: (hookId) => records.get(hookId),
		save: (hookId, record) => {
			records.set(hookId, record);
		},
	};
}

/**
 * Decide whether a call may proceed given the current record and time. When the
 * breaker is open but the cooldown has elapsed, the call is allowed as a
 * half-open probe.
 */
export function evaluateCircuit(
	record: CircuitBreakerRecord | undefined,
	nowMs: number,
	config: CircuitBreakerConfig
): { readonly state: CircuitState; readonly allowProbe: boolean } {
	const current = record ?? CLOSED_RECORD;
	if (current.openedAt === null) {
		return { state: 'closed', allowProbe: true };
	}
	if (nowMs - current.openedAt >= config.cooldownMs) {
		return { state: 'half-open', allowProbe: true };
	}
	return { state: 'open', allowProbe: false };
}

/** Fold a successful call into the record: the breaker fully closes. */
export function recordCircuitSuccess(): CircuitBreakerRecord {
	return CLOSED_RECORD;
}

/**
 * Fold a failed call into the record. Once consecutive failures reach the
 * threshold the breaker opens (or re-opens, from a failed half-open probe).
 */
export function recordCircuitFailure(
	record: CircuitBreakerRecord | undefined,
	nowMs: number,
	config: CircuitBreakerConfig
): CircuitBreakerRecord {
	const current = record ?? CLOSED_RECORD;
	const consecutiveFailures = current.consecutiveFailures + 1;
	const shouldOpen = consecutiveFailures >= config.failureThreshold || current.openedAt !== null;
	return Object.freeze({
		consecutiveFailures,
		openedAt: shouldOpen ? nowMs : null,
	});
}
