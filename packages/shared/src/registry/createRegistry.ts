/**
 * Generic, frozen-after-finalize registry used by every pluggable subsystem.
 *
 * Mirrors the lifecycle of the renderer block registry
 * (packages/email-renderer/src/blocks/index.ts) so all extension points
 * behave the same way: register at setup, finalize, then look up only.
 *
 * After `finalize()` no further mutations are allowed. Lookups remain free.
 */
export interface Registry<K, V> {
	/** Register a value under a key. Replaces any prior value for the same key. Throws after finalize. */
	register(key: K, value: V): void;
	/** Remove a registered entry. Returns true if an entry was removed. Throws after finalize. */
	unregister(key: K): boolean;
	/** Look up a registered value. */
	get(key: K): V | undefined;
	/** Whether a value is registered for the key. */
	has(key: K): boolean;
	/** Snapshot of all registered keys. */
	keys(): K[];
	/** Snapshot of all registered values. */
	values(): V[];
	/** Snapshot of all registered [key, value] pairs. */
	entries(): Array<[K, V]>;
	/** Freeze the registry so register/unregister throw. Idempotent. */
	finalize(): void;
	/** Whether finalize has been called. */
	isFinalized(): boolean;
}

/**
 * Create a new registry instance.
 *
 * The `name` is embedded in error messages to help locate the misuse —
 * e.g. `createRegistry('clientSimulators')` produces messages like
 * `clientSimulators registry is frozen — register before finalize().`
 */
export function createRegistry<K, V>(name: string): Registry<K, V> {
	if (!name || typeof name !== 'string') {
		throw new Error('createRegistry requires a non-empty name for diagnostics.');
	}

	const entries = new Map<K, V>();
	let frozen = false;

	const assertMutable = (op: string, key: K): void => {
		if (frozen) {
			throw new Error(
				`${name} registry is frozen — cannot ${op} "${String(key)}". Call ${op}() before finalize().`,
			);
		}
	};

	return {
		register(key, value) {
			assertMutable('register', key);
			entries.set(key, value);
		},
		unregister(key) {
			assertMutable('unregister', key);
			return entries.delete(key);
		},
		get(key) {
			return entries.get(key);
		},
		has(key) {
			return entries.has(key);
		},
		keys() {
			return Array.from(entries.keys());
		},
		values() {
			return Array.from(entries.values());
		},
		entries() {
			return Array.from(entries.entries());
		},
		finalize() {
			frozen = true;
		},
		isFinalized() {
			return frozen;
		},
	};
}
