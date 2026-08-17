/**
 * Offline store for the Postbox — a small typed IndexedDB-backed store.
 *
 * Two key families share one object store, with opposite failure contracts:
 *
 * CACHE (v1, READ-ONLY, best-effort) — persists just enough to make a cold
 * start instant and to keep already-read mail readable without a connection:
 *   - the newest ~200 inbox thread rows (the exact projection the list renders),
 *   - the sanitized bodies of the ~50 most-recently-READ messages.
 * Everything is namespaced by the active mailboxId (see the key helpers) so one
 * account's cache is never served to another on a shared device. (Folder-list
 * caching is a follow-up — see the PR body.)
 *
 * OUTBOX (v2) — queued sends composed while offline, stored payload-complete
 * (a fully-offline composition has no server draft row to point at). Unlike
 * the cache these writes are NOT fail-soft: losing queued mail silently is
 * data loss, so the outbox path throws ({@link OfflineWriteError}) and the
 * caller decides what to surface.
 *
 * INVARIANTS:
 *   - Only POST-sanitize HTML is ever stored on the cache side (the
 *     srcdoc/body the reader already renders in its sandbox). Raw mail never
 *     touches this store. Outbox payloads hold the user's OWN outgoing
 *     compose fields, never inbound mail.
 *   - Every CACHE operation fails soft. A missing/blocked IndexedDB, a
 *     serialization error, or a quota rejection disables cache writes and is
 *     swallowed — the app silently degrades to the online-only UX and surfaces
 *     the state in settings. The disabled latch applies to cache keys ONLY;
 *     outbox writes always reach the driver and surface their failures.
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
// v2 adds the `outbox:{ns}` key family. Outbox items live in the SAME `kv`
// object store as the cache — a new key prefix, not a new store — so the
// upgrade is purely a version bump; see {@link upgradeOfflineDb}.
export const DB_VERSION = 2;

// Every cache key is namespaced by the active mailbox so one account's cached
// inbox rows and message bodies can NEVER be served to a different mailbox on a
// shared device (desktop multi-workspace rail, or a shared browser profile).
// The namespace is the mailboxId; callers thread it through from the signed-in
// mailbox. Without a namespace nothing is read or written.
const threadsKey = (ns: string, folderRole: string) => `threads:${ns}:${folderRole}`;
const bodyKey = (ns: string, messageId: string) => `body:${ns}:${messageId}`;
const bodyIndexKey = (ns: string) => `body-index:${ns}`;
const outboxPrefix = (ns: string) => `outbox:${ns}:`;
const outboxKey = (ns: string, id: string) => `${outboxPrefix(ns)}${id}`;

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

/** An attachment already committed server-side, referenced by storage id. */
export interface OfflineComposeAttachmentRef {
	storageId: string;
	filename: string;
	contentType: string;
	size: number;
}

/**
 * The FULL compose payload of a queued offline send — everything needed to
 * replay `drafts.create → update → send` on reconnect. Payload-complete by
 * design: a fully-offline composition has no server draft row, so a bare
 * `draftId` reference would be unreplayable. Ids are plain strings (this is a
 * pure data layer; the drain path casts back to Convex ids).
 */
export interface OfflineComposePayload {
	mailboxId: string;
	/** The server draft row, when one existed before the device went offline. */
	draftId?: string;
	inReplyToMessageId?: string;
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
	/** Serialized EditorBlock[] — present only in 'full' composer mode. */
	bodyBlocks?: string;
	composerMode: 'simple' | 'full';
	fromAddress?: string;
	followUpRemindAt?: number | null;
	/** Refs to already-uploaded attachments; offline-added files cannot queue. */
	attachments: OfflineComposeAttachmentRef[];
	sendOptions?: {
		undoSendDelayMs?: number;
		scheduledSendAt?: number;
		allowUnsealed?: boolean;
	};
}

/** One queued send in the `outbox:{ns}` key family. */
export interface OfflineOutboxItem {
	id: string;
	payload: OfflineComposePayload;
	queuedAt: number;
	attempts: number;
	lastError?: string;
}

/**
 * A failed OUTBOX write, rethrown so the caller can tell the user the truth
 * (the cache's fail-soft swallow is wrong for queued mail). `isQuotaExceeded`
 * distinguishes "this device is out of storage" from a broken backend.
 */
export class OfflineWriteError extends Error {
	readonly isQuotaExceeded: boolean;

	constructor(message: string, opts: { cause: unknown; isQuotaExceeded: boolean }) {
		super(message, { cause: opts.cause });
		this.name = 'OfflineWriteError';
		this.isQuotaExceeded = opts.isQuotaExceeded;
	}
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

	/**
	 * Reason writes were disabled, if any — an i18n KEY (the registry
	 * convention: a pure module never calls `useI18n`), which the surface that
	 * shows it runs through `t()`.
	 */
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
				? 'shared.postboxOfflineStore.outOfStorage'
				: 'shared.postboxOfflineStore.unavailable';
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
	 * Throwing write path for queued mail. Deliberately independent of
	 * {@link safeSet}: it neither consults nor trips the session `disabled`
	 * latch, so a cache write that ran the device out of quota earlier in the
	 * session cannot poison outbox writes — and a failed outbox write surfaces
	 * as {@link OfflineWriteError} instead of being swallowed.
	 */
	private async mustSet(key: string, value: unknown): Promise<void> {
		try {
			await this.driver.set(key, value);
		} catch (err) {
			// Diagnostic English: this module is pure and has no vue-i18n. The
			// sentence the sender reads is chosen from `isQuotaExceeded` at the
			// render boundary (usePostboxOfflineOutbox), not from `message`.
			throw new OfflineWriteError(
				isQuotaError(err)
					? 'This device is out of storage — the message could not be queued.'
					: 'Offline storage is unavailable on this device — the message could not be queued.',
				{ cause: err, isQuotaExceeded: isQuotaError(err) }
			);
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

	/**
	 * Queue a send composed offline under `ns` (the active mailboxId). Returns
	 * the stored item — its `id` doubles as the idempotency key the drain path
	 * threads through as the draft client nonce. Throws {@link OfflineWriteError}
	 * (quota included) instead of failing soft: queued mail must never be
	 * silently dropped.
	 */
	async enqueueOutbox(ns: string, payload: OfflineComposePayload): Promise<OfflineOutboxItem> {
		const item: OfflineOutboxItem = {
			id: newOutboxId(),
			payload,
			queuedAt: Date.now(),
			attempts: 0,
		};
		await this.mustSet(outboxKey(ns, item.id), item);
		return item;
	}

	/**
	 * Every queued send for `ns`, oldest first (the drain replays in queue
	 * order). Read errors propagate — a swallowed failure here would silently
	 * hide queued mail from the drain.
	 */
	async listOutbox(ns: string): Promise<OfflineOutboxItem[]> {
		const prefix = outboxPrefix(ns);
		const keys = (await this.driver.keys()).filter((key) => key.startsWith(prefix));
		const items = await Promise.all(keys.map((key) => this.driver.get<OfflineOutboxItem>(key)));
		return items
			.filter((item): item is OfflineOutboxItem => item !== undefined)
			.sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
	}

	/** Drop one queued send (sent successfully, or cancelled while offline). */
	async removeOutbox(ns: string, id: string): Promise<void> {
		await this.driver.delete(outboxKey(ns, id));
	}

	/**
	 * Record a delivery attempt on a queued item: increments `attempts` and
	 * sets `lastError` (or clears it when omitted). Returns the updated item,
	 * or `null` when the item no longer exists (already sent or removed).
	 */
	async markOutboxAttempt(
		ns: string,
		id: string,
		lastError?: string
	): Promise<OfflineOutboxItem | null> {
		const existing = await this.driver.get<OfflineOutboxItem>(outboxKey(ns, id));
		if (existing === undefined) return null;
		const next: OfflineOutboxItem = { ...existing, attempts: existing.attempts + 1 };
		if (lastError === undefined) delete next.lastError;
		else next.lastError = lastError;
		await this.mustSet(outboxKey(ns, id), next);
		return next;
	}

	/**
	 * Wipe every cached row and body (all mailboxes) from this device. Also
	 * drops queued outbox items — callers gate this behind an explicit user
	 * action and warn when sends are still queued.
	 */
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

/** Collision-resistant id for a queued outbox item (also its client nonce). */
function newOutboxId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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
		keys: () =>
			tx<string[]>('readonly', (s) => s.getAllKeys() as IDBRequest).then(
				(k) => (k as unknown as string[]) ?? []
			),
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
