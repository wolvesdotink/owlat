import { describe, expect, it } from 'vitest';
import {
	createInMemoryCircuitBreakerStore,
	DEFAULT_CIRCUIT_BREAKER_CONFIG,
	evaluateCircuit,
	recordCircuitFailure,
	recordCircuitSuccess,
	type CircuitBreakerRecord,
} from '../hooks/circuitBreaker';

const config = DEFAULT_CIRCUIT_BREAKER_CONFIG;
const T = 1_000_000;

describe('evaluateCircuit', () => {
	it('allows a probe when there is no record (closed)', () => {
		expect(evaluateCircuit(undefined, T, config)).toEqual({ state: 'closed', allowProbe: true });
	});

	it('blocks while open and within the cooldown', () => {
		const record: CircuitBreakerRecord = { consecutiveFailures: 5, openedAt: T };
		expect(evaluateCircuit(record, T + config.cooldownMs - 1, config)).toEqual({
			state: 'open',
			allowProbe: false,
		});
	});

	it('allows a half-open probe once the cooldown elapses', () => {
		const record: CircuitBreakerRecord = { consecutiveFailures: 5, openedAt: T };
		expect(evaluateCircuit(record, T + config.cooldownMs, config)).toEqual({
			state: 'half-open',
			allowProbe: true,
		});
	});
});

describe('recordCircuitFailure', () => {
	it('stays closed below the threshold', () => {
		let record: CircuitBreakerRecord | undefined;
		for (let i = 1; i < config.failureThreshold; i++) {
			record = recordCircuitFailure(record, T, config);
			expect(record.openedAt).toBeNull();
			expect(record.consecutiveFailures).toBe(i);
		}
	});

	it('opens exactly at the threshold', () => {
		let record: CircuitBreakerRecord | undefined;
		for (let i = 0; i < config.failureThreshold; i++) {
			record = recordCircuitFailure(record, T, config);
		}
		expect(record?.openedAt).toBe(T);
	});

	it('re-opens on a failed half-open probe even below the threshold', () => {
		const halfOpen: CircuitBreakerRecord = { consecutiveFailures: 1, openedAt: T };
		const next = recordCircuitFailure(halfOpen, T + 100, config);
		expect(next.openedAt).toBe(T + 100);
	});
});

describe('recordCircuitSuccess', () => {
	it('fully closes the breaker', () => {
		expect(recordCircuitSuccess()).toEqual({ consecutiveFailures: 0, openedAt: null });
	});
});

describe('in-memory store', () => {
	it('round-trips a record by hook id', () => {
		const store = createInMemoryCircuitBreakerStore();
		expect(store.load('h')).toBeUndefined();
		const record = recordCircuitFailure(undefined, T, config);
		store.save('h', record);
		expect(store.load('h')).toEqual(record);
	});
});
