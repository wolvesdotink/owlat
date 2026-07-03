import { describe, it, expect } from 'vitest';
import {
	PostboxOfflineStore,
	reconcileThreadRows,
	OFFLINE_THREADS_CAP,
	OFFLINE_BODIES_CAP,
	type OfflineKvDriver,
} from '../postboxOfflineStore';

/** Minimal in-memory driver standing in for IndexedDB. */
function memoryDriver(): OfflineKvDriver & { map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	return {
		map,
		async get<T>(key: string) {
			return map.get(key) as T | undefined;
		},
		async set(key, value) {
			// Round-trip through JSON so tests catch anything unserializable, like
			// the real structured-clone boundary would.
			map.set(key, JSON.parse(JSON.stringify(value)));
		},
		async delete(key) {
			map.delete(key);
		},
		async keys() {
			return [...map.keys()];
		},
		async clear() {
			map.clear();
		},
	};
}

/** A driver whose writes always throw a QuotaExceededError. */
function quotaDriver(): OfflineKvDriver {
	const base = memoryDriver();
	return {
		...base,
		async set() {
			throw new DOMException('exceeded', 'QuotaExceededError');
		},
	};
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, ...extra });

describe('PostboxOfflineStore', () => {
	it('round-trips folders, threads and bodies', async () => {
		const store = new PostboxOfflineStore(memoryDriver());
		await store.saveFolders([{ role: 'inbox' }]);
		await store.saveThreads('inbox', [row('a'), row('b')]);
		await store.saveBody('a', '<p>hi</p>');

		expect(await store.loadFolders()).toEqual([{ role: 'inbox' }]);
		expect(await store.loadThreads('inbox')).toEqual([row('a'), row('b')]);
		expect((await store.loadBody('a'))?.srcdoc).toBe('<p>hi</p>');
		expect(await store.loadBody('missing')).toBeNull();
	});

	it('caps stored threads at OFFLINE_THREADS_CAP', async () => {
		const store = new PostboxOfflineStore(memoryDriver());
		const many = Array.from({ length: OFFLINE_THREADS_CAP + 50 }, (_, i) => row(`r${i}`));
		await store.saveThreads('inbox', many);

		const loaded = await store.loadThreads('inbox');
		expect(loaded).toHaveLength(OFFLINE_THREADS_CAP);
		// Head is kept (newest rows the caller passed first).
		expect(loaded[0]).toEqual(row('r0'));
	});

	it('LRU-caps cached bodies and evicts the least-recently-read', async () => {
		const driver = memoryDriver();
		const store = new PostboxOfflineStore(driver);
		for (let i = 0; i < OFFLINE_BODIES_CAP + 5; i++) {
			await store.saveBody(`m${i}`, `body-${i}`);
		}
		// The 5 oldest were evicted.
		expect(await store.loadBody('m0')).toBeNull();
		expect(await store.loadBody('m4')).toBeNull();
		expect((await store.loadBody('m5'))?.srcdoc).toBe('body-5');
		// Never keeps more than the cap worth of body entries.
		const bodyKeys = [...driver.map.keys()].filter((k) => k.startsWith('body:'));
		expect(bodyKeys).toHaveLength(OFFLINE_BODIES_CAP);
	});

	it('re-reading a body moves it to most-recently-used (survives eviction)', async () => {
		const store = new PostboxOfflineStore(memoryDriver());
		for (let i = 0; i < OFFLINE_BODIES_CAP; i++) await store.saveBody(`m${i}`, `b${i}`);
		// Re-read/refresh m0 so it is no longer the oldest.
		await store.saveBody('m0', 'b0-fresh');
		// One more insert evicts the now-oldest (m1), not m0.
		await store.saveBody('new', 'bn');
		expect(await store.loadBody('m1')).toBeNull();
		expect((await store.loadBody('m0'))?.srcdoc).toBe('b0-fresh');
	});

	it('clear() wipes every cached row, folder and body', async () => {
		const driver = memoryDriver();
		const store = new PostboxOfflineStore(driver);
		await store.saveFolders([{ role: 'inbox' }]);
		await store.saveThreads('inbox', [row('a')]);
		await store.saveBody('a', 'x');

		await store.clear();

		expect(driver.map.size).toBe(0);
		expect(await store.loadFolders()).toBeNull();
		expect(await store.loadThreads('inbox')).toEqual([]);
		expect(await store.loadBody('a')).toBeNull();
	});

	it('disables writes on a quota error without throwing', async () => {
		const store = new PostboxOfflineStore(quotaDriver());
		await expect(store.saveThreads('inbox', [row('a')])).resolves.toBeUndefined();
		expect(store.writesDisabled).toBe(true);
		expect(store.reason).toMatch(/storage/i);
		// Reads still resolve (to empty) rather than throw.
		expect(await store.loadThreads('inbox')).toEqual([]);
	});

	it('stops attempting further writes once disabled', async () => {
		let sets = 0;
		const driver: OfflineKvDriver = {
			async get() {
				return undefined;
			},
			async set() {
				sets++;
				throw new DOMException('exceeded', 'QuotaExceededError');
			},
			async delete() {},
			async keys() {
				return [];
			},
			async clear() {},
		};
		const store = new PostboxOfflineStore(driver);
		await store.saveFolders([]);
		await store.saveThreads('inbox', [row('a')]);
		await store.saveBody('a', 'x');
		// Only the first write actually reached the backend; the rest short-circuit.
		expect(sets).toBe(1);
	});
});

describe('reconcileThreadRows', () => {
	it('returns cached rows while the live query is still pending', () => {
		const cached = [row('a'), row('b')];
		expect(reconcileThreadRows(cached, null)).toEqual(cached);
		expect(reconcileThreadRows(cached, undefined)).toEqual(cached);
	});

	it('prefers live rows once they arrive (live is authoritative)', () => {
		const cached = [row('a', { subject: 'stale' }), row('gone')];
		const live = [row('a', { subject: 'fresh' }), row('c')];
		const result = reconcileThreadRows(cached, live);
		// Live content wins for shared ids; cached-only rows are dropped.
		expect(result).toEqual(live);
		expect(result.find((r) => r._id === 'gone')).toBeUndefined();
	});

	it('returns an empty list when live is an empty (settled) result', () => {
		expect(reconcileThreadRows([row('a')], [])).toEqual([]);
	});
});
