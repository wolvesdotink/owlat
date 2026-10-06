/**
 * The key/value driver under the Postbox's on-device stores: the offline cache
 * and outbox (`postboxOfflineStore.ts`), the folder cache and the draft mirror
 * (`postboxDraftMirrorStore.ts`). One IndexedDB database, one object store,
 * one connection per page.
 *
 * Every write settles on its TRANSACTION, not its request: a request can
 * succeed and its transaction still abort, and a caller that drops another
 * copy on the strength of a write must only ever see a committed one. Where
 * IndexedDB is unavailable (SSR, privacy mode, an old engine) a no-op driver
 * stands in and says so (`persistent: false`).
 *
 * Split out of `postboxOfflineStore.ts` for the file-size ratchet.
 */

export const DB_NAME = 'owlat-postbox-offline';
export const STORE_NAME = 'kv';
// v2 adds the `outbox:{ns}` key family. Outbox items live in the SAME `kv`
// object store as the cache — a new key prefix, not a new store — so the
// upgrade is purely a version bump; see {@link upgradeOfflineDb}.
export const DB_VERSION = 2;

/** Minimal async key/value contract the store is built on. */
export interface OfflineKvDriver {
	get<T>(key: string): Promise<T | undefined>;
	/** Resolves once the write's transaction has committed; rejects on abort. */
	set(key: string, value: unknown): Promise<void>;
	/** Resolves once the delete's transaction has committed; rejects on abort. */
	delete(key: string): Promise<void>;
	keys(): Promise<string[]>;
	clear(): Promise<void>;
	/**
	 * Whether writes are actually stored. False for the no-op driver, so a
	 * caller that must not drop its only other copy can tell a write that went
	 * nowhere from one that landed. Absent means persistent.
	 */
	readonly persistent?: boolean;
	/**
	 * Read `key`, run `predicate` on the stored value and delete the key only if
	 * it returns true, all inside ONE transaction, so a value written between
	 * the caller's earlier read and this call is judged, not blindly deleted.
	 * Resolves true when it deleted (committed), false when the predicate
	 * refused. Optional: callers fall back to a read then a delete.
	 */
	deleteIf?(key: string, predicate: (current: unknown) => boolean): Promise<boolean>;
	/**
	 * Write `value` only if `key` holds nothing, inside ONE transaction. True
	 * when written (committed), false when something was already there.
	 */
	setIfAbsent?(key: string, value: unknown): Promise<boolean>;
}

/**
 * Schema upgrade for the offline DB. Exported so the v1→v2 path is testable
 * without a real IndexedDB.
 *
 * v1 → v2 introduces the `outbox:{ns}` key family INSIDE the existing `kv`
 * object store — a new key prefix, not a new store. The upgrade must therefore
 * only ever create the store when it is missing (a fresh install); it must
 * never delete or recreate an existing store, which would drop a v1 device's
 * cached rows and bodies.
 */
export function upgradeOfflineDb(
	db: Pick<IDBDatabase, 'objectStoreNames' | 'createObjectStore'>,
	storeName: string = STORE_NAME
): void {
	if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
}

/**
 * Real IndexedDB-backed driver. Returns `null` when IndexedDB is unavailable
 * (SSR, privacy mode, or an old engine) so callers can no-op cleanly.
 */
export function createIndexedDbDriver(
	dbName: string = DB_NAME,
	storeName: string = STORE_NAME
): OfflineKvDriver | null {
	if (typeof indexedDB === 'undefined') return null;

	let dbPromise: Promise<IDBDatabase> | null = null;
	function openDb(): Promise<IDBDatabase> {
		if (dbPromise) return dbPromise;
		dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(dbName, DB_VERSION);
			req.onupgradeneeded = () => {
				upgradeOfflineDb(req.result, storeName);
			};
			req.onsuccess = () => resolve(req.result);
			req.addEventListener('error', () => reject(req.error ?? new Error('IndexedDB open failed')));
		});
		return dbPromise;
	}

	// Settles on the TRANSACTION, not the request: a request can succeed and
	// its transaction still abort, and a caller deleting its other copy on the
	// strength of a write must only ever see a committed one.
	function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
		return openDb().then(
			(db) =>
				new Promise<T>((resolve, reject) => {
					const transaction = db.transaction(storeName, mode);
					const request = run(transaction.objectStore(storeName));
					let result: T;
					request.onsuccess = () => {
						result = request.result as T;
					};
					transaction.oncomplete = () => resolve(result);
					transaction.addEventListener('abort', () =>
						reject(transaction.error ?? request.error ?? new Error('IndexedDB transaction aborted'))
					);
				})
		);
	}

	function deleteIf(key: string, predicate: (current: unknown) => boolean): Promise<boolean> {
		return openDb().then(
			(db) =>
				new Promise<boolean>((resolve, reject) => {
					const transaction = db.transaction(storeName, 'readwrite');
					const store = transaction.objectStore(storeName);
					let deleted = false;
					const read = store.get(key);
					read.onsuccess = () => {
						let approve = false;
						try {
							approve = predicate(read.result);
						} catch {
							approve = false;
						}
						if (approve) {
							store.delete(key);
							deleted = true;
						}
					};
					transaction.oncomplete = () => resolve(deleted);
					transaction.addEventListener('abort', () =>
						reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
					);
				})
		);
	}

	function setIfAbsent(key: string, value: unknown): Promise<boolean> {
		return openDb().then(
			(db) =>
				new Promise<boolean>((resolve, reject) => {
					const transaction = db.transaction(storeName, 'readwrite');
					const store = transaction.objectStore(storeName);
					let written = false;
					const read = store.get(key);
					read.onsuccess = () => {
						if (read.result !== undefined) return;
						store.put(value, key);
						written = true;
					};
					transaction.oncomplete = () => resolve(written);
					transaction.addEventListener('abort', () =>
						reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
					);
				})
		);
	}

	return {
		persistent: true,
		setIfAbsent,
		get: <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key)),
		set: (key, value) => tx<void>('readwrite', (s) => s.put(value, key)),
		delete: (key) => tx<void>('readwrite', (s) => s.delete(key)),
		keys: () =>
			tx<string[]>('readonly', (s) => s.getAllKeys() as IDBRequest).then(
				(k) => (k as unknown as string[]) ?? []
			),
		clear: () => tx<void>('readwrite', (s) => s.clear()),
		deleteIf,
	};
}

let sharedDriver: OfflineKvDriver | null = null;

/** The one driver this session; shared with `postboxDraftMirrorStore.ts`. */
export function getOfflineKvDriver(): OfflineKvDriver {
	sharedDriver ??= createIndexedDbDriver() ?? createNoopDriver();
	return sharedDriver;
}

/** A driver that stores nothing — used when IndexedDB is unavailable. */
export function createNoopDriver(): OfflineKvDriver {
	return {
		persistent: false,
		deleteIf: async () => false,
		setIfAbsent: async () => false,
		get: async () => undefined,
		set: async () => {},
		delete: async () => {},
		keys: async () => [],
		clear: async () => {},
	};
}
