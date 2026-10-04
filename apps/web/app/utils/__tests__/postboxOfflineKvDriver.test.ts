/**
 * The real IndexedDB driver behind the Postbox offline store and the draft
 * mirror (`postboxOfflineKvDriver.ts`), run against `fake-indexeddb` (a
 * spec-following in-memory IndexedDB).
 *
 * What these cases protect:
 *   - COMMITTED MEANS COMMITTED. `set` / `delete` settle on the TRANSACTION,
 *     not the request: a request can succeed and its transaction still abort,
 *     and the draft mirror deletes its other copy on the strength of a write.
 *     So a resolved write is readable from a fresh connection, and an abort
 *     after request success rejects (and leaves nothing behind).
 *   - CONDITIONAL DELETE (`deleteIf`) reads, decides and deletes inside ONE
 *     readwrite transaction: a value replaced before it runs is judged, not
 *     blindly deleted, and the result says whether it deleted.
 *   - NO STORAGE, NO PRETENDING. Without IndexedDB the no-op driver reports
 *     `persistent: false`, so the mirror treats its writes as failed.
 *
 * `createIndexedDbDriver` reads the global `indexedDB` when it is called, so
 * a fake factory is installed for the file and every case opens its own
 * database name.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { sameStoredValue } from '../postboxDraftMirror';
import { PostboxDraftMirrorStore } from '../postboxDraftMirrorStore';
import {
	STORE_NAME,
	createIndexedDbDriver,
	createNoopDriver,
	type OfflineKvDriver,
} from '../postboxOfflineKvDriver';
import { OfflineWriteError, PostboxOfflineStore } from '../postboxOfflineStore';

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const factory = new IDBFactory();

function installIndexedDb(value: unknown) {
	Object.defineProperty(globalThis, 'indexedDB', { configurable: true, writable: true, value });
}

function restoreIndexedDb() {
	if (originalIndexedDb) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
	else delete (globalThis as { indexedDB?: unknown }).indexedDB;
}

beforeAll(() => installIndexedDb(factory));
afterAll(restoreIndexedDb);
afterEach(() => {
	vi.restoreAllMocks();
});

let dbCounter = 0;
let currentDb = '';

/** A real driver over a database no other case touches. */
function freshDriver(): OfflineKvDriver {
	currentDb = `owlat-postbox-offline-test-${++dbCounter}`;
	const driver = createIndexedDbDriver(currentDb);
	if (!driver) throw new Error('fake-indexeddb was not installed');
	return driver;
}

/** Read a key through a SEPARATE connection and transaction: what is committed. */
function readCommitted(key: string, dbName: string = currentDb): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const open = factory.open(dbName);
		open.addEventListener('error', () => reject(open.error));
		open.addEventListener('success', () => {
			const db = open.result;
			const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
			request.addEventListener('success', () => {
				resolve(request.result);
				db.close();
			});
			request.addEventListener('error', () => reject(request.error));
		});
	});
}

/**
 * Make the NEXT call of an object-store method abort its transaction right
 * after the request itself succeeded: the case a request-settled driver would
 * report as a success. `fired.success` proves the request did succeed first.
 */
function abortAfterNextRequestSuccess(method: 'put' | 'delete') {
	const fired = { success: false };
	const original = IDBObjectStore.prototype[method] as (...args: unknown[]) => IDBRequest;
	vi.spyOn(IDBObjectStore.prototype, method).mockImplementationOnce(function (
		this: IDBObjectStore,
		...args: unknown[]
	) {
		const request = original.apply(this, args);
		request.addEventListener('success', () => {
			fired.success = true;
			this.transaction.abort();
		});
		return request;
	} as never);
	return fired;
}

describe('IndexedDB driver: set / delete', () => {
	it('reports itself persistent and offers a conditional delete', async () => {
		const driver = freshDriver();
		expect(driver.persistent).toBe(true);
		expect(typeof driver.deleteIf).toBe('function');
	});

	it('resolves set only once the value is committed (readable from a fresh connection)', async () => {
		const driver = freshDriver();
		await driver.set('draft-mirror:v2:mbxA:d1:s1:live', { v: 2, savedAt: 1 });

		expect(await readCommitted('draft-mirror:v2:mbxA:d1:s1:live')).toEqual({ v: 2, savedAt: 1 });
		expect(await driver.get('draft-mirror:v2:mbxA:d1:s1:live')).toEqual({ v: 2, savedAt: 1 });
	});

	it('resolves set after the transaction completes, not when the request succeeds', async () => {
		const driver = freshDriver();
		await driver.keys(); // open the connection first
		const order: string[] = [];
		const put = IDBObjectStore.prototype.put;
		vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (
			this: IDBObjectStore,
			...args: Parameters<IDBObjectStore['put']>
		) {
			const request = put.apply(this, args);
			request.addEventListener('success', () => order.push('request success'));
			this.transaction.addEventListener('complete', () => order.push('transaction complete'));
			return request;
		});

		await driver.set('k', 'v').then(() => order.push('set resolved'));
		expect(order).toEqual(['request success', 'transaction complete', 'set resolved']);
	});

	it('rejects set, and stores nothing, when the transaction aborts after the request succeeded', async () => {
		const driver = freshDriver();
		const fired = abortAfterNextRequestSuccess('put');

		await expect(driver.set('k', 'v')).rejects.toBeTruthy();
		expect(fired.success).toBe(true);
		expect(await readCommitted('k')).toBeUndefined();
	});

	it('resolves delete once committed, and rejects (keeping the value) when it aborts', async () => {
		const driver = freshDriver();
		await driver.set('a', 1);
		await driver.set('b', 2);

		await driver.delete('a');
		expect(await readCommitted('a')).toBeUndefined();

		const fired = abortAfterNextRequestSuccess('delete');
		await expect(driver.delete('b')).rejects.toBeTruthy();
		expect(fired.success).toBe(true);
		expect(await readCommitted('b')).toBe(2);
	});

	it('lists keys and clears', async () => {
		const driver = freshDriver();
		await driver.set('x', 1);
		await driver.set('y', 2);
		expect((await driver.keys()).sort()).toEqual(['x', 'y']);
		await driver.clear();
		expect(await driver.keys()).toEqual([]);
	});
});

describe('IndexedDB driver: deleteIf', () => {
	const key = 'draft-mirror:v2:mbxA:d1:s1:live';
	const stored = { v: 2, savedAt: 1, fields: { subject: 'Invoice 4471' } };

	it('deletes and resolves true when the predicate approves the stored value', async () => {
		const driver = freshDriver();
		await driver.set(key, stored);
		const seen: unknown[] = [];

		const deleted = await driver.deleteIf!(key, (current) => {
			seen.push(current);
			return sameStoredValue(current, stored);
		});
		expect(deleted).toBe(true);
		expect(seen).toEqual([stored]);
		expect(await readCommitted(key)).toBeUndefined();
	});

	it('matches a separately cloned equal object (IndexedDB hands back clones)', async () => {
		const driver = freshDriver();
		await driver.set(key, stored);
		const expected = structuredClone(stored);
		expect(await driver.deleteIf!(key, (current) => sameStoredValue(current, expected))).toBe(true);
	});

	it('keeps the value and resolves false when the predicate refuses', async () => {
		const driver = freshDriver();
		await driver.set(key, stored);
		expect(await driver.deleteIf!(key, () => false)).toBe(false);
		expect(await readCommitted(key)).toEqual(stored);
	});

	it('treats a throwing predicate as a refusal', async () => {
		const driver = freshDriver();
		await driver.set(key, stored);
		expect(
			await driver.deleteIf!(key, () => {
				throw new Error('boom');
			})
		).toBe(false);
		expect(await readCommitted(key)).toEqual(stored);
	});

	it('hands the predicate undefined for a missing key', async () => {
		const driver = freshDriver();
		const seen: unknown[] = [];
		expect(
			await driver.deleteIf!('missing', (current) => {
				seen.push(current);
				return false;
			})
		).toBe(false);
		expect(seen).toEqual([undefined]);
	});

	it('refuses when the value was replaced after the caller read it', async () => {
		const driver = freshDriver();
		await driver.set(key, stored);
		const scanned = await driver.get(key);
		const newer = { ...stored, savedAt: 2, fields: { subject: 'Typed after the scan' } };
		await driver.set(key, newer);

		expect(await driver.deleteIf!(key, (current) => sameStoredValue(current, scanned))).toBe(false);
		expect(await readCommitted(key)).toEqual(newer);
	});

	it('judges a replacement queued just ahead of it, even when neither was awaited', async () => {
		const driver = freshDriver();
		await driver.set(key, stored);
		const newer = { ...stored, savedAt: 2 };

		// Readwrite transactions on one store run in creation order, so the
		// conditional delete sees the replacement, not the value it expected.
		const write = driver.set(key, newer);
		const conditional = driver.deleteIf!(key, (current) => sameStoredValue(current, stored));
		await write;
		expect(await conditional).toBe(false);
		expect(await readCommitted(key)).toEqual(newer);
	});

	it('rejects, keeping the value, when its transaction aborts after approving', async () => {
		const driver = freshDriver();
		await driver.set(key, stored);
		const fired = abortAfterNextRequestSuccess('delete');

		await expect(driver.deleteIf!(key, () => true)).rejects.toBeTruthy();
		expect(fired.success).toBe(true);
		expect(await readCommitted(key)).toEqual(stored);
	});
});

const MIRROR_COPY = {
	v: 2 as const,
	fields: {
		toAddresses: [],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'x',
		bodyHtml: '',
		bodyBlocks: '[]',
		composerMode: 'simple' as const,
		followUpRemindAt: null,
	},
	base: null,
	savedAt: 1,
	draftId: 'd1',
	inReplyTo: null,
};

describe('without IndexedDB', () => {
	it('has no IndexedDB driver to create', () => {
		delete (globalThis as { indexedDB?: unknown }).indexedDB;
		try {
			expect(createIndexedDbDriver('owlat-postbox-offline-absent')).toBeNull();
		} finally {
			installIndexedDb(factory);
		}
	});

	it('the no-op driver stores nothing and reports persistent false', async () => {
		const driver = createNoopDriver();

		expect(driver.persistent).toBe(false);
		await driver.set('k', 'v');
		expect(await driver.get('k')).toBeUndefined();
		expect(await driver.keys()).toEqual([]);
		expect(await driver.deleteIf!('k', () => true)).toBe(false);
	});

	it('the shared driver falls back to the no-op driver', async () => {
		delete (globalThis as { indexedDB?: unknown }).indexedDB;
		try {
			vi.resetModules();
			const { getOfflineKvDriver } = await import('../postboxOfflineKvDriver');
			expect(getOfflineKvDriver().persistent).toBe(false);
		} finally {
			installIndexedDb(factory);
		}
	});

	it('makes the draft mirror report every write as failed', async () => {
		const store = new PostboxDraftMirrorStore(createNoopDriver());
		expect(store.persistent).toBe(false);
		expect(await store.write('draft-mirror:v2:mbxA:d1:s1:live', MIRROR_COPY)).toBe(false);
	});
});

describe('stores over the IndexedDB driver', () => {
	it('the draft mirror reports a committed write as true and an aborted one as false', async () => {
		const store = new PostboxDraftMirrorStore(freshDriver());
		expect(store.persistent).toBe(true);
		expect(await store.write('draft-mirror:v2:mbxA:d1:s1:live', MIRROR_COPY)).toBe(true);
		expect(await readCommitted('draft-mirror:v2:mbxA:d1:s1:live')).toEqual(MIRROR_COPY);

		abortAfterNextRequestSuccess('put');
		expect(await store.write('draft-mirror:v2:mbxA:d1:s2:live', MIRROR_COPY)).toBe(false);
		expect(await readCommitted('draft-mirror:v2:mbxA:d1:s2:live')).toBeUndefined();
	});

	it('the offline store round-trips cache and outbox, and surfaces aborted outbox writes', async () => {
		const store = new PostboxOfflineStore(freshDriver());

		await store.saveThreads('u:mbxA', 'inbox', [{ _id: 't1' }]);
		expect(await store.loadThreads('u:mbxA', 'inbox')).toEqual([{ _id: 't1' }]);

		const item = await store.enqueueOutbox('mbxA', { to: ['ines@northwind.studio'] } as never);
		expect((await store.listOutbox('mbxA')).map((i) => i.id)).toEqual([item.id]);

		abortAfterNextRequestSuccess('put');
		await expect(store.enqueueOutbox('mbxA', { to: [] } as never)).rejects.toBeInstanceOf(
			OfflineWriteError
		);
		expect(await store.listOutbox('mbxA')).toHaveLength(1);

		abortAfterNextRequestSuccess('delete');
		await expect(store.removeOutbox('mbxA', item.id)).rejects.toBeTruthy();
		expect(await store.listOutbox('mbxA')).toHaveLength(1);
		await store.removeOutbox('mbxA', item.id);
		expect(await store.listOutbox('mbxA')).toEqual([]);
	});

	it('the offline store disables cache writes after an aborted cache write', async () => {
		const store = new PostboxOfflineStore(freshDriver());
		abortAfterNextRequestSuccess('put');
		await store.saveThreads('u:mbxA', 'inbox', [{ _id: 't1' }]);
		expect(store.writesDisabled).toBe(true);
		expect(await store.loadThreads('u:mbxA', 'inbox')).toEqual([]);
	});
});
