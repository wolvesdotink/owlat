/**
 * Pure circuit-breaker state machine for signed synchronous hooks. Every
 * transition is exercised with a deterministic clock: closed → open on a run of
 * failures, open short-circuits until the cooldown elapses, then a single
 * half-open trial either closes it (success) or re-opens it (failure).
 */

import { describe, expect, it } from 'vitest';
import {
	INITIAL_HOOK_CIRCUIT_STATE,
	isHookCircuitOpen,
	recordHookFailure,
	recordHookSuccess,
	type HookCircuitConfig,
	type HookCircuitState,
} from '../hookCircuit';

const CONFIG: HookCircuitConfig = { failureThreshold: 3, cooldownMs: 1_000 };
const T0 = 1_000_000;

function failNTimes(n: number, at: number): HookCircuitState {
	let state = INITIAL_HOOK_CIRCUIT_STATE;
	for (let i = 0; i < n; i++) state = recordHookFailure(state, at, CONFIG);
	return state;
}

describe('closed breaker', () => {
	it('starts closed and stays closed below the threshold', () => {
		expect(isHookCircuitOpen(INITIAL_HOOK_CIRCUIT_STATE, T0)).toBe(false);
		const state = failNTimes(2, T0);
		expect(state.consecutiveFailures).toBe(2);
		expect(isHookCircuitOpen(state, T0)).toBe(false);
	});
});

describe('tripping open', () => {
	it('opens once the failure count reaches the threshold', () => {
		const state = failNTimes(3, T0);
		expect(state.openedUntil).toBe(T0 + CONFIG.cooldownMs);
		expect(isHookCircuitOpen(state, T0)).toBe(true);
		expect(isHookCircuitOpen(state, T0 + 999)).toBe(true);
	});

	it('becomes half-open (not open) once the cooldown elapses', () => {
		const state = failNTimes(3, T0);
		expect(isHookCircuitOpen(state, T0 + CONFIG.cooldownMs)).toBe(false);
		expect(isHookCircuitOpen(state, T0 + CONFIG.cooldownMs + 1)).toBe(false);
	});
});

describe('recovery', () => {
	it('a success fully closes the breaker and resets the counter', () => {
		const opened = failNTimes(3, T0);
		expect(isHookCircuitOpen(opened, T0)).toBe(true);
		const closed = recordHookSuccess();
		expect(closed).toEqual(INITIAL_HOOK_CIRCUIT_STATE);
		expect(closed.openedUntil).toBeUndefined();
		expect(isHookCircuitOpen(closed, T0)).toBe(false);
	});

	it('a failed half-open trial re-opens for a fresh cooldown', () => {
		const opened = failNTimes(3, T0);
		// Cooldown elapsed → half-open. The trial call fails at a later time.
		const retryAt = T0 + CONFIG.cooldownMs + 50;
		const reopened = recordHookFailure(opened, retryAt, CONFIG);
		expect(reopened.consecutiveFailures).toBe(4);
		expect(reopened.openedUntil).toBe(retryAt + CONFIG.cooldownMs);
		expect(isHookCircuitOpen(reopened, retryAt)).toBe(true);
	});
});

describe('config guards', () => {
	it('treats a threshold below 1 as 1 (opens on the first failure)', () => {
		const state = recordHookFailure(INITIAL_HOOK_CIRCUIT_STATE, T0, {
			failureThreshold: 0,
			cooldownMs: 500,
		});
		expect(isHookCircuitOpen(state, T0)).toBe(true);
	});
});
