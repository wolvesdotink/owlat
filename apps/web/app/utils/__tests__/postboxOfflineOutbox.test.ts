import { describe, it, expect } from 'vitest';
import {
	PostboxOfflineStore,
	OfflineWriteError,
	upgradeOfflineDb,
	DB_VERSION,
	type OfflineComposePayload,
	type OfflineKvDriver,
} from '../postboxOfflineStore';

/**
 * Minimal in-memory driver standing in for IndexedDB. The backing map is
 * exposed so tests can hand the SAME map to a second store instance — that is
 * what "survives reload" means at this layer.
 */
function memoryDriver(map: Map<string, unknown> = new Map()): OfflineKvDriver & {
	map: Map<string, unknown>;
} {
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

const MBX = 'mbxA';

function payload(overrides: Partial<OfflineComposePayload> = {}): OfflineComposePayload {
	return {
		mailboxId: MBX,
		toAddresses: ['a@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Queued while offline',
		bodyHtml: '<p>hi</p>',
		composerMode: 'simple',
		attachments: [],
		...overrides,
	};
}

describe('offline outbox', () => {
	it('enqueues a payload-complete item and survives reload', async () => {
		const map = new Map<string, unknown>();
		const store = new PostboxOfflineStore(memoryDriver(map));

		const full = payload({
			draftId: 'draft1',
			fromAddress: 'me@example.com',
			followUpRemindAt: 123,
			attachments: [
				{ storageId: 's1', filename: 'a.pdf', contentType: 'application/pdf', size: 9 },
			],
			sendOptions: { undoSendDelayMs: 5000 },
		});
		const item = await store.enqueueOutbox(MBX, full);
		expect(item.id).toBeTruthy();
		expect(item.attempts).toBe(0);
		expect(item.lastError).toBeUndefined();

		// A brand-new store over the SAME backing map (i.e. after a reload) sees
		// the queued item with the payload fully intact.
		const reloaded = new PostboxOfflineStore(memoryDriver(map));
		const listed = await reloaded.listOutbox(MBX);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.id).toBe(item.id);
		expect(listed[0]?.payload).toEqual(full);
	});

	it('lists oldest-first and only the namespace asked for', async () => {
		const store = new PostboxOfflineStore(memoryDriver());
		const first = await store.enqueueOutbox(MBX, payload({ subject: 'first' }));
		const second = await store.enqueueOutbox(MBX, payload({ subject: 'second' }));
		await store.enqueueOutbox('mbxB', payload({ subject: 'other mailbox' }));

		const listed = await store.listOutbox(MBX);
		expect(listed.map((i) => i.id)).toEqual(
			[first, second]
				.sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id))
				.map((i) => i.id)
		);
		expect(listed.map((i) => i.payload.subject)).not.toContain('other mailbox');
		expect(await store.listOutbox('mbxB')).toHaveLength(1);
	});

	it('remove drops exactly one item', async () => {
		const store = new PostboxOfflineStore(memoryDriver());
		const a = await store.enqueueOutbox(MBX, payload({ subject: 'a' }));
		const b = await store.enqueueOutbox(MBX, payload({ subject: 'b' }));

		await store.removeOutbox(MBX, a.id);

		const remaining = await store.listOutbox(MBX);
		expect(remaining.map((i) => i.id)).toEqual([b.id]);
	});

	it('markOutboxAttempt keeps attempts/lastError bookkeeping', async () => {
		const store = new PostboxOfflineStore(memoryDriver());
		const item = await store.enqueueOutbox(MBX, payload());

		const failed = await store.markOutboxAttempt(MBX, item.id, 'network unreachable');
		expect(failed?.attempts).toBe(1);
		expect(failed?.lastError).toBe('network unreachable');

		// A later attempt without an error clears lastError.
		const retried = await store.markOutboxAttempt(MBX, item.id);
		expect(retried?.attempts).toBe(2);
		expect(retried?.lastError).toBeUndefined();

		// Bookkeeping is persisted, not just returned.
		const [listed] = await store.listOutbox(MBX);
		expect(listed?.attempts).toBe(2);
		expect(listed?.lastError).toBeUndefined();

		// A missing id (already sent / removed) is a null, not a throw.
		expect(await store.markOutboxAttempt(MBX, 'gone')).toBeNull();
	});

	it('quota failure throws OfflineWriteError instead of swallowing', async () => {
		const store = new PostboxOfflineStore(quotaDriver());

		const err = await store.enqueueOutbox(MBX, payload()).then(
			() => null,
			(e: unknown) => e
		);
		expect(err).toBeInstanceOf(OfflineWriteError);
		expect((err as OfflineWriteError).isQuotaExceeded).toBe(true);
		expect((err as OfflineWriteError).message).toMatch(/storage/i);
		// Nothing half-written pretends to be queued.
		expect(await store.listOutbox(MBX)).toHaveLength(0);
	});

	it("safeSet's session disabled latch does not poison outbox writes", async () => {
		// A driver whose FIRST write fails (tripping the cache latch) and then
		// recovers — e.g. a transient backend error early in the session.
		let failNext = true;
		const base = memoryDriver();
		const driver: OfflineKvDriver = {
			...base,
			async set(key, value) {
				if (failNext) {
					failNext = false;
					throw new DOMException('exceeded', 'QuotaExceededError');
				}
				await base.set(key, value);
			},
		};
		const store = new PostboxOfflineStore(driver);

		// Cache write trips the fail-soft latch.
		await store.saveThreads(MBX, 'inbox', [{ _id: 'a' }]);
		expect(store.writesDisabled).toBe(true);

		// The outbox still writes — the latch is a cache-only concern.
		const item = await store.enqueueOutbox(MBX, payload());
		expect((await store.listOutbox(MBX)).map((i) => i.id)).toEqual([item.id]);
		// And the outbox write did not silently re-enable cache writes either.
		expect(store.writesDisabled).toBe(true);
	});

	it('an outbox write failure does not disable the cache latch', async () => {
		// Outbox writes fail, cache writes work: the two paths stay independent.
		const base = memoryDriver();
		const driver: OfflineKvDriver = {
			...base,
			async set(key, value) {
				if (key.startsWith('outbox:')) throw new DOMException('exceeded', 'QuotaExceededError');
				await base.set(key, value);
			},
		};
		const store = new PostboxOfflineStore(driver);

		await expect(store.enqueueOutbox(MBX, payload())).rejects.toBeInstanceOf(OfflineWriteError);
		expect(store.writesDisabled).toBe(false);

		await store.saveThreads(MBX, 'inbox', [{ _id: 'a' }]);
		expect(await store.loadThreads(MBX, 'inbox')).toEqual([{ _id: 'a' }]);
	});
});

describe('v1 → v2 upgrade', () => {
	/**
	 * Just enough of IDBDatabase for the upgrade handler: object stores with
	 * their keys, tracking creations and deletions.
	 */
	function fakeDb(storeNames: string[]) {
		const stores = new Map<string, Map<string, unknown>>(
			storeNames.map((name) => [name, new Map()])
		);
		const created: string[] = [];
		return {
			stores,
			created,
			objectStoreNames: {
				contains: (name: string) => stores.has(name),
			} as unknown as DOMStringList,
			createObjectStore(name: string) {
				created.push(name);
				stores.set(name, new Map());
				return undefined as unknown as IDBObjectStore;
			},
		};
	}

	it('is version 2', () => {
		expect(DB_VERSION).toBe(2);
	});

	it('preserves every v1 cache key on upgrade', () => {
		// A v1 database: the `kv` store already exists and holds cached data.
		const db = fakeDb(['kv']);
		const kv = db.stores.get('kv')!;
		kv.set('threads:mbxA:inbox', [{ _id: 'a' }]);
		kv.set('body:mbxA:m1', { srcdoc: '<p>hi</p>', cachedAt: 1 });
		kv.set('body-index:mbxA', ['m1']);

		upgradeOfflineDb(db);

		// The existing store was neither recreated nor touched — every cached
		// row, body, and index entry survives the version bump.
		expect(db.created).toEqual([]);
		expect(db.stores.get('kv')).toBe(kv);
		expect([...kv.keys()]).toEqual(['threads:mbxA:inbox', 'body:mbxA:m1', 'body-index:mbxA']);
	});

	it('creates the store on a fresh install', () => {
		const db = fakeDb([]);
		upgradeOfflineDb(db);
		expect(db.created).toEqual(['kv']);
	});
});
