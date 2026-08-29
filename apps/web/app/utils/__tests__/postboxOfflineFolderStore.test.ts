import { describe, it, expect } from 'vitest';
import { OFFLINE_FOLDERS_CAP, PostboxOfflineFolderStore } from '../postboxOfflineFolderStore';
import type { OfflineKvDriver } from '../postboxOfflineStore';

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

const folder = (id: string, name: string) => ({ _id: id, name, unseenCount: 0 });

describe('PostboxOfflineFolderStore', () => {
	it('round-trips the rail and stamps when it was written', async () => {
		const store = new PostboxOfflineFolderStore(memoryDriver());
		await store.saveFolders('mbxA', [folder('f1', 'Inbox'), folder('f2', 'Archive')]);

		expect(await store.loadFolders('mbxA')).toEqual([
			folder('f1', 'Inbox'),
			folder('f2', 'Archive'),
		]);
		const meta = await store.loadFoldersMeta('mbxA');
		expect(typeof meta?.savedAt).toBe('number');
	});

	it("never serves one mailbox's folders to another", async () => {
		const store = new PostboxOfflineFolderStore(memoryDriver());
		await store.saveFolders('mbxA', [folder('f1', 'Legal hold')]);

		expect(await store.loadFolders('mbxB')).toEqual([]);
		expect(await store.loadFoldersMeta('mbxB')).toBeNull();
	});

	it('caps the stored rail at OFFLINE_FOLDERS_CAP', async () => {
		const store = new PostboxOfflineFolderStore(memoryDriver());
		const many = Array.from({ length: OFFLINE_FOLDERS_CAP + 25 }, (_, i) =>
			folder(`f${i}`, `Folder ${i}`)
		);
		await store.saveFolders('mbxA', many);

		expect(await store.loadFolders('mbxA')).toHaveLength(OFFLINE_FOLDERS_CAP);
	});

	it('fails soft on a quota rejection — no throw, nothing half-written', async () => {
		const base = memoryDriver();
		const store = new PostboxOfflineFolderStore({
			...base,
			async set() {
				throw new DOMException('exceeded', 'QuotaExceededError');
			},
		});

		await expect(store.saveFolders('mbxA', [folder('f1', 'Inbox')])).resolves.toBeUndefined();
		expect(await store.loadFolders('mbxA')).toEqual([]);
	});

	it('reads fail soft too — a broken backend is an empty rail, not a crash', async () => {
		const base = memoryDriver();
		const store = new PostboxOfflineFolderStore({
			...base,
			async get() {
				throw new Error('IndexedDB is blocked');
			},
		});

		expect(await store.loadFolders('mbxA')).toEqual([]);
		expect(await store.loadFoldersMeta('mbxA')).toBeNull();
	});

	it('leaves the rows standing when only the freshness stamp fails', async () => {
		const base = memoryDriver();
		let writes = 0;
		const store = new PostboxOfflineFolderStore({
			...base,
			async set(key, value) {
				writes += 1;
				// First write is the rail, second is the meta stamp.
				if (writes > 1) throw new Error('nope');
				await base.set(key, value);
			},
		});

		await store.saveFolders('mbxA', [folder('f1', 'Inbox')]);
		expect(await store.loadFolders('mbxA')).toEqual([folder('f1', 'Inbox')]);
		expect(await store.loadFoldersMeta('mbxA')).toBeNull();
	});
});
