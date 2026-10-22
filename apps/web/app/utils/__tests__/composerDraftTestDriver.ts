/**
 * In-memory stand-in for the IndexedDB driver under the composer-draft store.
 * Values are structured-cloned on the way in and out, like IndexedDB. `hold()`
 * parks every operation started after it until the returned release runs, so a
 * test can put a write or the first load "in flight" without timers.
 */
import type { OfflineKvDriver } from '../postboxOfflineKvDriver';

export type ComposerDraftTestDriver = OfflineKvDriver & {
	map: Map<string, unknown>;
	/** Writes and deletes in the order they committed. */
	log: string[];
	hold: () => () => void;
};

export function composerDraftTestDriver(
	options: { persistent?: boolean; failWrites?: boolean } = {}
): ComposerDraftTestDriver {
	const map = new Map<string, unknown>();
	const log: string[] = [];
	let gate: Promise<void> | null = null;
	const pass = async () => {
		if (gate) await gate;
	};
	const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
	return {
		map,
		log,
		persistent: options.persistent ?? true,
		async get<T>(key: string) {
			await pass();
			return clone(map.get(key)) as T | undefined;
		},
		async set(key, value) {
			await pass();
			if (options.failWrites) throw new Error('QuotaExceededError');
			map.set(key, clone(value));
			log.push(`set ${key}`);
		},
		async delete(key) {
			await pass();
			map.delete(key);
			log.push(`delete ${key}`);
		},
		async keys() {
			await pass();
			return [...map.keys()];
		},
		async clear() {
			map.clear();
		},
		async deleteIf(key, predicate) {
			await pass();
			if (!predicate(clone(map.get(key)))) return false;
			map.delete(key);
			log.push(`delete ${key}`);
			return true;
		},
		hold() {
			let release = () => {};
			gate = new Promise<void>((resolve) => {
				release = () => {
					gate = null;
					resolve();
				};
			});
			return release;
		},
	};
}
