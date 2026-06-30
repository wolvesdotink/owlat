import { describe, it, expect } from 'vitest';
import { createRegistry, type Registry } from '../createRegistry';

// =============================================================================
// Bucket 1 — Unit: registry lifecycle
// =============================================================================
describe('createRegistry — unit lifecycle', () => {
	it('registers and retrieves a value', () => {
		const reg = createRegistry<string, number>('test');
		reg.register('a', 1);
		expect(reg.get('a')).toBe(1);
		expect(reg.has('a')).toBe(true);
	});

	it('overrides a prior value for the same key (last write wins, pre-finalize)', () => {
		const reg = createRegistry<string, number>('test');
		reg.register('a', 1);
		reg.register('a', 2);
		expect(reg.get('a')).toBe(2);
		expect(reg.keys()).toEqual(['a']);
	});

	it('unregisters and reports the removal', () => {
		const reg = createRegistry<string, number>('test');
		reg.register('a', 1);
		expect(reg.unregister('a')).toBe(true);
		expect(reg.has('a')).toBe(false);
		expect(reg.get('a')).toBeUndefined();
	});

	it('unregister of a non-existent key returns false (silent)', () => {
		const reg = createRegistry<string, number>('test');
		expect(reg.unregister('missing')).toBe(false);
	});

	it('keys/values/entries return independent snapshot arrays', () => {
		const reg = createRegistry<string, number>('test');
		reg.register('a', 1);
		reg.register('b', 2);
		const keys = reg.keys();
		const values = reg.values();
		const entries = reg.entries();
		expect(keys.sort()).toEqual(['a', 'b']);
		expect(values.sort()).toEqual([1, 2]);
		expect(entries.sort()).toEqual([['a', 1], ['b', 2]]);
		// Mutating the snapshot must not affect the registry
		keys.push('c');
		expect(reg.has('c')).toBe(false);
	});

	it('finalize() flips isFinalized() and is idempotent', () => {
		const reg = createRegistry<string, number>('test');
		expect(reg.isFinalized()).toBe(false);
		reg.finalize();
		expect(reg.isFinalized()).toBe(true);
		reg.finalize();
		reg.finalize();
		expect(reg.isFinalized()).toBe(true);
	});
});

// =============================================================================
// Bucket 2 — Contract: every Registry instance honours the same contract
//
// createRegistry IS the contract for all downstream registries. We exercise the
// public surface as a single suite so any future Registry-shaped wrapper can
// reuse it.
// =============================================================================
function registryContract(makeRegistry: () => Registry<string, string>): void {
	describe('Registry<K,V> contract', () => {
		it('has() returns false for unregistered keys', () => {
			expect(makeRegistry().has('nope')).toBe(false);
		});

		it('get() returns undefined for unregistered keys', () => {
			expect(makeRegistry().get('nope')).toBeUndefined();
		});

		it('keys() and values() are empty on a fresh registry', () => {
			const reg = makeRegistry();
			expect(reg.keys()).toEqual([]);
			expect(reg.values()).toEqual([]);
			expect(reg.entries()).toEqual([]);
		});

		it('register followed by unregister yields a fresh state', () => {
			const reg = makeRegistry();
			reg.register('x', 'one');
			reg.unregister('x');
			expect(reg.keys()).toEqual([]);
		});
	});
}

describe('createRegistry — Registry<K,V> contract', () => {
	registryContract(() => createRegistry<string, string>('contract-test'));
});

// =============================================================================
// Bucket 3 — Behavior-parity / regression
//
// createRegistry is new code so there is no pre-refactor parity to capture,
// but we lock the public surface to a snapshot so reorderings or accidental
// renames break the build.
// =============================================================================
describe('createRegistry — public surface stability', () => {
	it('exposes the documented Registry methods', () => {
		const reg = createRegistry<string, number>('stable');
		const surface = Object.keys(reg).sort();
		expect(surface).toMatchInlineSnapshot(`
			[
			  "entries",
			  "finalize",
			  "get",
			  "has",
			  "isFinalized",
			  "keys",
			  "register",
			  "unregister",
			  "values",
			]
		`);
	});
});

// =============================================================================
// Bucket 4 — Extension proof
//
// A third-party registers an entry inside a registry it did not author and
// every consumer reads it back identically to a first-party entry.
// =============================================================================
describe('createRegistry — extension proof', () => {
	it('treats first-party and third-party entries identically', () => {
		const reg = createRegistry<string, { source: string }>('extensible');

		// First-party setup (as core code would do)
		reg.register('built-in', { source: 'first-party' });

		// Third-party registration (as a plugin would do)
		reg.register('plugin', { source: 'third-party' });

		// Consumers cannot distinguish where an entry came from
		expect(reg.get('built-in')).toEqual({ source: 'first-party' });
		expect(reg.get('plugin')).toEqual({ source: 'third-party' });
		expect(reg.keys().sort()).toEqual(['built-in', 'plugin']);
		expect(reg.values().length).toBe(2);
	});

	it('independent registry instances do not share state', () => {
		const a = createRegistry<string, number>('a');
		const b = createRegistry<string, number>('b');
		a.register('x', 1);
		expect(b.has('x')).toBe(false);
	});
});

// =============================================================================
// Bucket 5 — Failure modes
// =============================================================================
describe('createRegistry — failure modes', () => {
	it('register after finalize throws with a clear, name-tagged message', () => {
		const reg = createRegistry<string, number>('clientSimulators');
		reg.finalize();
		expect(() => reg.register('gmail', 1)).toThrowError(
			/clientSimulators registry is frozen — cannot register "gmail"/,
		);
	});

	it('unregister after finalize throws with a clear, name-tagged message', () => {
		const reg = createRegistry<string, number>('clientSimulators');
		reg.register('gmail', 1);
		reg.finalize();
		expect(() => reg.unregister('gmail')).toThrowError(
			/clientSimulators registry is frozen — cannot unregister "gmail"/,
		);
	});

	it('register is rejected even when value already matched (no smuggling past freeze)', () => {
		const reg = createRegistry<string, number>('test');
		reg.register('a', 1);
		reg.finalize();
		expect(() => reg.register('a', 1)).toThrow();
	});

	it('lookups remain available after finalize', () => {
		const reg = createRegistry<string, number>('test');
		reg.register('a', 1);
		reg.finalize();
		expect(reg.get('a')).toBe(1);
		expect(reg.has('a')).toBe(true);
		expect(reg.keys()).toEqual(['a']);
	});

	it('createRegistry requires a non-empty name', () => {
		expect(() => createRegistry<string, number>('')).toThrowError(/non-empty name/);
		// @ts-expect-error testing runtime guard against bad inputs
		expect(() => createRegistry<string, number>(undefined)).toThrowError(/non-empty name/);
	});

	it('a thrown register after finalize does not corrupt internal state', () => {
		const reg = createRegistry<string, number>('test');
		reg.register('a', 1);
		reg.finalize();
		try {
			reg.register('b', 2);
		} catch {
			// expected
		}
		expect(reg.has('b')).toBe(false);
		expect(reg.get('a')).toBe(1);
	});
});
