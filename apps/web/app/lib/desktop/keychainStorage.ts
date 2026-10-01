/**
 * Synchronous session storage backed by the OS keychain, one instance per
 * workspace keychain entry.
 *
 * `crossDomainClient` requires a *synchronous* `storage` ({ getItem, setItem }),
 * but the OS keychain is async (it goes through Tauri `invoke`). Each storage
 * bridges the gap with an in-memory write-through cache:
 *
 *   - it is created with the entry's persisted blob and (optionally) a persister;
 *   - `getItem`/`setItem` operate on the cache synchronously;
 *   - `setItem`/`removeItem` schedule a debounced write of the whole blob back to
 *     the keychain through the persister.
 *
 * A storage is bound to ONE account for its whole life and is never re-pointed,
 * so an auth client built on it can only ever read and write that workspace's
 * session. The whole cache is serialized as one JSON blob per workspace, so we
 * never need to know `crossDomainClient`'s internal key names (cookie vs
 * local-cache).
 *
 * Every open window (main, compose) has its own storage for the same entry.
 * A storage is created at the session revision it read and writes only
 * against it (see the desktop `secrets.rs`). Once another window has signed in
 * again or removed the workspace, the storage is retired for good and the
 * window binds a new storage to the current session (`rebindActiveSession`).
 * The auth client sits on `activeSessionStorage`, which follows the bound
 * storage, and writes what each answer says into the storage its request went
 * out with (see `desktopAuthClient.ts`), so an answer to the older session can only
 * reach the retired storage.
 */
import type { SessionEntry, SessionWriteOutcome } from '@owlat/desktop/src/keychain';

/** How a storage reaches its keychain entry. */
export interface SessionPersistence {
	/** Write `blob` if the entry is still at `revision`. */
	write(accountKey: string, blob: string, revision: number): Promise<SessionWriteOutcome>;
	/** The entry as it is now; null when the keychain cannot be read. */
	read(accountKey: string): Promise<SessionEntry | null>;
}

export interface KeychainSessionStorage {
	/** The keychain entry this storage reads from and writes to. Fixed. */
	readonly accountKey: string;
	/** The session revision this storage was created at. Fixed. */
	readonly revision: number;
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
	/** The cache serialized as the blob persisted to the keychain. */
	snapshot(): string;
	/**
	 * Write any pending change now instead of after the debounce, and wait for
	 * every write this storage has started. A reload would otherwise drop a
	 * change the debounce was still holding.
	 */
	flush(): Promise<void>;
	/**
	 * Stop writing to the keychain and wait for the writes already started.
	 * Resolves with a function that resumes writing (and writes what changed in
	 * the meantime). Used while another owner writes the same entry.
	 */
	suspend(): Promise<() => void>;
	/**
	 * Stop writing for good and forget the cached session, without writing the
	 * emptied cache: the workspace is being removed and its entry deleted.
	 */
	discard(): Promise<void>;
	/**
	 * The session this storage holds was replaced elsewhere: stop writing for
	 * good. Reads and in-memory changes still work, so a client still using it
	 * finishes what it was doing without touching the keychain.
	 */
	retire(): void;
}

/** Options for {@link createKeychainStorage}. */
export interface KeychainStorageOptions {
	/**
	 * Called once when a write is refused because the session was replaced.
	 * Awaited in the write chain, so a `flush` returns after it.
	 */
	onStale?: () => void | Promise<void>;
}

const FLUSH_DEBOUNCE_MS = 150;

function parseBlob(blob: string | null): Record<string, string> {
	if (!blob) return {};
	try {
		const parsed = JSON.parse(blob) as Record<string, string>;
		if (parsed && typeof parsed === 'object') return parsed;
	} catch {
		// Corrupt blob — start clean; the next auth flow re-populates it.
	}
	return {};
}

/**
 * A storage for one keychain entry. `initial` is the entry as read (null for a
 * fresh entry). With no `persistence`, the storage is memory-only until its
 * owner stores `snapshot()` itself — the connect handshake keeps a session it
 * has not confirmed off the keychain that way.
 */
export function createKeychainStorage(
	accountKey: string,
	initial: SessionEntry | null,
	persistence: SessionPersistence | null,
	options: KeychainStorageOptions = {}
): KeychainSessionStorage {
	let cache = parseBlob(initial?.value ?? null);
	const revision = initial?.revision ?? 0;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let dirty = false;
	let suspended = false;
	let discarded = false;
	// Set once the session this storage holds has been replaced elsewhere.
	let retired = false;
	// Writes are chained so two flushes can never land out of order.
	let writes: Promise<void> = Promise.resolve();

	function cancelTimer(): void {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
	}

	function canWrite(): boolean {
		return !!persistence && !suspended && !discarded && !retired;
	}

	function retire(): void {
		cancelTimer();
		retired = true;
		dirty = false;
	}

	function writeNow(): Promise<void> {
		cancelTimer();
		if (!dirty || !canWrite()) return writes;
		dirty = false;
		const blob = JSON.stringify(cache);
		writes = writes
			.then(async () => {
				const outcome = await persistence!.write(accountKey, blob, revision);
				// The session was replaced since this storage read it: what it
				// holds is the older session. Stop, and let the owner bind the
				// current one.
				if (outcome === 'stale' && !retired) {
					retire();
					await options.onStale?.();
				}
			})
			.catch(() => {});
		return writes;
	}

	function changed(): void {
		dirty = true;
		if (!canWrite()) return;
		cancelTimer();
		flushTimer = setTimeout(() => {
			flushTimer = null;
			void writeNow();
		}, FLUSH_DEBOUNCE_MS);
	}

	return {
		accountKey,
		revision,
		getItem(key) {
			return key in cache ? cache[key]! : null;
		},
		setItem(key, value) {
			cache[key] = value;
			changed();
		},
		removeItem(key) {
			delete cache[key];
			changed();
		},
		snapshot() {
			return JSON.stringify(cache);
		},
		flush() {
			return writeNow();
		},
		async suspend() {
			cancelTimer();
			suspended = true;
			await writes;
			return () => {
				if (discarded) return;
				suspended = false;
				void writeNow();
			};
		},
		async discard() {
			cancelTimer();
			discarded = true;
			cache = {};
			dirty = false;
			await writes;
		},
		retire,
	};
}

/**
 * The storage of the workspace this webview is signed in to, set by the boot
 * hydration (`loadWorkspaces`). A workspace switch reloads the webview; within
 * a page it changes only when the session is replaced from another window
 * (`rebindActiveSession`).
 */
let activeStorage: KeychainSessionStorage | null = null;
let activePersistence: SessionPersistence | null = null;
/**
 * Moves each time a storage is bound. An auth request records it when it goes
 * out, so an answer to a request sent with an older session can be dropped
 * before it reaches the client (see `sessionFencedFetch`).
 */
let sessionGeneration = 0;
const reboundListeners = new Set<() => void>();

export function setActiveKeychainStorage(storage: KeychainSessionStorage | null): void {
	activeStorage = storage;
}

export function getActiveKeychainStorage(): KeychainSessionStorage | null {
	return activeStorage;
}

/** The generation of the storage bound now. */
export function getSessionGeneration(): number {
	return sessionGeneration;
}

/**
 * The page's session storage, whichever is bound: what the workspace's auth
 * client is built on, so the client (and everything subscribed to it) stays
 * the same when the session under it is replaced.
 */
export const activeSessionStorage: Pick<KeychainSessionStorage, 'getItem' | 'setItem'> = {
	getItem: (key) => activeStorage?.getItem(key) ?? null,
	setItem: (key, value) => activeStorage?.setItem(key, value),
};

/** Called after a replaced session was bound in this page. Returns the unsubscribe. */
export function onSessionRebound(listener: () => void): () => void {
	reboundListeners.add(listener);
	return () => void reboundListeners.delete(listener);
}

/**
 * Bind this webview to `accountKey`'s session as read (`entry`): the storage
 * every auth call of the page goes through until the session is replaced.
 */
export function bindActiveSession(
	accountKey: string,
	entry: SessionEntry | null,
	persistence: SessionPersistence
): KeychainSessionStorage {
	activePersistence = persistence;
	activeStorage = createKeychainStorage(accountKey, entry, persistence, {
		onStale: () => rebindActiveSession(accountKey),
	});
	sessionGeneration += 1;
	return activeStorage;
}

/**
 * The session of `accountKey` was replaced elsewhere (at `revision`, when
 * known): retire the storage this webview holds and bind a new one to the
 * session as it is now, then tell the listeners. The retired storage writes
 * nothing from then on. When the current session cannot be read, the retired
 * storage stays bound, holding the old session in memory only.
 */
export async function rebindActiveSession(accountKey: string, revision?: number): Promise<void> {
	const current = activeStorage;
	const persistence = activePersistence;
	if (!current || !persistence || current.accountKey !== accountKey) return;
	if (revision !== undefined && revision === current.revision) return;
	current.retire();
	const entry = await persistence.read(accountKey);
	// A rebind that started later has already bound a newer storage.
	if (activeStorage !== current || !entry) return;
	bindActiveSession(accountKey, entry, persistence);
	for (const listener of reboundListeners) listener();
}
