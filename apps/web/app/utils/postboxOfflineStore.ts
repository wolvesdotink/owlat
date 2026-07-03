/**
 * Offline read cache for the Postbox — a small typed IndexedDB-backed store.
 *
 * V1 is READ-ONLY and best-effort. It persists just enough to make a cold start
 * instant and to keep already-read mail readable without a connection:
 *   - the newest ~200 inbox thread rows (the exact projection the list renders),
 *   - the sanitized bodies of the ~50 most-recently-READ messages.
 * Everything is namespaced by the active mailboxId (see the key helpers) so one
 * account's cache is never served to another on a shared device. (Folder-list
 * caching is a follow-up — see the PR body.)
 *
 * INVARIANTS:
 *   - Only POST-sanitize HTML is ever stored (the srcdoc/body the reader already
 *     renders in its sandbox). Raw mail never touches this store.
 *   - Every operation fails soft. A missing/blocked IndexedDB, a serialization
 *     error, or a quota rejection disables writes and is swallowed — the app
 *     silently degrades to the online-only UX and surfaces the state in settings.
 *   - This module is a pure data layer: no Vue reactivity, no DOM, no network.
 *     It talks to an injectable {@link OfflineKvDriver} so it is unit-testable
 *     with an in-memory (or quota-throwing) driver and needs no real IndexedDB.
 */

/** Newest inbox rows retained for instant cold start. */
export const OFFLINE_THREADS_CAP = 200;
/** Most-recently-read sanitized bodies retained for offline reading. */
export const OFFLINE_BODIES_CAP = 50;

const DB_NAME = 'owlat-postbox-offline';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

// Every cache key is namespaced by the active mailbox so one account's cached
// inbox rows and message bodies can NEVER be served to a different mailbox on a
// shared device (desktop multi-workspace rail, or a shared browser profile).
// The namespace is the mailboxId; callers thread it through from the signed-in
// mailbox. Without a namespace nothing is read or written.
const threadsKey = (ns: string, folderRole: string) => `threads:${ns}:${folderRole}`;
const bodyKey = (ns: string, messageId: string) => `body:${ns}:${messageId}`;
const bodyIndexKey = (ns: string) => `body-index:${ns}`;

/** Minimal async key/value contract the store is built on. */
export interface OfflineKvDriver {
	get<T>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	keys(): Promise<string[]>;
	clear(): Promise<void>;
}

/** A cached, post-sanitize message body. */
export interface OfflineBodyEntry {
	/** Post-sanitize iframe document (the reader's `srcdoc`). Never raw mail. */
	srcdoc: string;
	/** When it was cached (ms) — used only for debugging/introspection. */
	cachedAt: number;
}

/**
 * A row is `QuotaExceededError` when the browser refuses the write. Different
 * engines name it differently, so match by name/DOMException rather than type.
 */
function isQuotaError(err: unknown): boolean {
	if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
		return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED';
	}
	return err instanceof Error && /quota/i.test(err.message);
}

/**
 * Reconcile cached rows against the live query result: live data always wins.
 * While the live query is still pending (`null`/`undefined`) the cached rows
 * stand in; the instant live has produced a value it fully replaces the cached
 * set — including dropping cached-only rows, so a deleted/moved message never
 * lingers. This is a whole-list swap, not an id-level merge: the server is
 * authoritative, so `cached` is intentionally unused once `live` has arrived.
 */
export function reconcileThreadRows<T extends { _id: string }>(
	cached: readonly T[],
	live: readonly T[] | null | undefined
): T[] {
	if (live == null) return [...cached];
	return live.map((row) => ({ ...row }));
}

/**
 * Typed façade over an {@link OfflineKvDriver}. Construct with the real
 * IndexedDB driver in the app, or an in-memory driver in tests.
 */
export class PostboxOfflineStore {
	private readonly driver: OfflineKvDriver;
	private disabled = false;
	private disabledReason: string | null = null;

	constructor(driver: OfflineKvDriver) {
		this.driver = driver;
	}

	/** True once a write failed (quota/serialize/backend) — reads still work. */
	get writesDisabled(): boolean {
		return this.disabled;
	}

	/** Human-readable reason writes were disabled, if any. */
	get reason(): string | null {
		return this.disabledReason;
	}

	/** Best-effort write; disables future writes (and swallows) on failure. */
	private async safeSet(key: string, value: unknown): Promise<boolean> {
		if (this.disabled) return false;
		try {
			await this.driver.set(key, value);
			return true;
		} catch (err) {
			this.disabled = true;
			this.disabledReason = isQuotaError(err)
				? 'This device is out of storage for offline mail.'
				: 'Local mail cache is unavailable on this device.';
			return false;
		}
	}

	/** Best-effort read; a failure returns the fallback rather than throwing. */
	private async safeGet<T>(key: string, fallback: T): Promise<T> {
		try {
			const value = await this.driver.get<T>(key);
			return value === undefined ? fallback : value;
		} catch {
			return fallback;
		}
	}

	/**
	 * Persist the newest rows for a folder in `ns`. Capped at
	 * {@link OFFLINE_THREADS_CAP} — callers pass the list as rendered; we keep
	 * only the head. `ns` is the active mailboxId so a different mailbox's cold
	 * start never reads these rows.
	 */
	async saveThreads<T>(ns: string, folderRole: string, rows: readonly T[]): Promise<void> {
		await this.safeSet(threadsKey(ns, folderRole), rows.slice(0, OFFLINE_THREADS_CAP));
	}

	async loadThreads<T>(ns: string, folderRole: string): Promise<T[]> {
		return this.safeGet<T[]>(threadsKey(ns, folderRole), []);
	}

	/**
	 * Cache one message's post-sanitize body under `ns` (the active mailboxId),
	 * LRU-capped per-namespace at {@link OFFLINE_BODIES_CAP}. Re-reading a message
	 * moves it to the most-recent end; overflow evicts the least-recently-read
	 * body (and its index entry).
	 */
	async saveBody(ns: string, messageId: string, srcdoc: string): Promise<void> {
		const entry: OfflineBodyEntry = { srcdoc, cachedAt: Date.now() };
		if (!(await this.safeSet(bodyKey(ns, messageId), entry))) return;

		const index = await this.safeGet<string[]>(bodyIndexKey(ns), []);
		const next = index.filter((id) => id !== messageId);
		next.push(messageId);
		// Evict least-recently-read bodies over the cap (best-effort deletes).
		while (next.length > OFFLINE_BODIES_CAP) {
			const evicted = next.shift();
			if (evicted === undefined) break;
			try {
				await this.driver.delete(bodyKey(ns, evicted));
			} catch {
				// A failed eviction just leaves an orphan body; harmless.
			}
		}
		await this.safeSet(bodyIndexKey(ns), next);
	}

	async loadBody(ns: string, messageId: string): Promise<OfflineBodyEntry | null> {
		return this.safeGet<OfflineBodyEntry | null>(bodyKey(ns, messageId), null);
	}

	/** Wipe every cached row and body (all mailboxes) from this device. */
	async clear(): Promise<void> {
		try {
			await this.driver.clear();
			// A successful clear proves the backend works again — re-enable writes.
			this.disabled = false;
			this.disabledReason = null;
		} catch {
			// Fall back to targeted deletes; if even those throw, leave as-is.
			try {
				const keys = await this.driver.keys();
				await Promise.all(keys.map((k) => this.driver.delete(k).catch(() => {})));
			} catch {
				// Nothing more we can safely do.
			}
		}
	}
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
				const db = req.result;
				if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
		});
		return dbPromise;
	}

	function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
		return openDb().then(
			(db) =>
				new Promise<T>((resolve, reject) => {
					const transaction = db.transaction(storeName, mode);
					const request = run(transaction.objectStore(storeName));
					request.onsuccess = () => resolve(request.result as T);
					request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
				})
		);
	}

	return {
		get: <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key)),
		set: (key, value) => tx<void>('readwrite', (s) => s.put(value, key)),
		delete: (key) => tx<void>('readwrite', (s) => s.delete(key)),
		keys: () => tx<string[]>('readonly', (s) => s.getAllKeys() as IDBRequest).then((k) => (k as unknown as string[]) ?? []),
		clear: () => tx<void>('readwrite', (s) => s.clear()),
	};
}

let singleton: PostboxOfflineStore | null = null;

/**
 * The shared Postbox offline store for this session, backed by real IndexedDB.
 * When IndexedDB is unavailable it is backed by a no-op driver so every call is
 * a safe miss (reads return empty, writes silently disable).
 */
export function getPostboxOfflineStore(): PostboxOfflineStore {
	if (singleton) return singleton;
	const driver = createIndexedDbDriver() ?? createNoopDriver();
	singleton = new PostboxOfflineStore(driver);
	return singleton;
}

/** A driver that stores nothing — used when IndexedDB is unavailable. */
function createNoopDriver(): OfflineKvDriver {
	return {
		get: async () => undefined,
		set: async () => {},
		delete: async () => {},
		keys: async () => [],
		clear: async () => {},
	};
}
