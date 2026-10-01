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
 * A storage remembers the session revision it read and writes only against it
 * (see the desktop `secrets.rs`): once another window has signed in again or
 * removed the workspace, a write of the older session is refused, and the
 * storage reads the current session instead of keeping the one it held.
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
	/**
	 * The session revision this storage holds. It moves when the storage takes
	 * a session replaced elsewhere, so an auth response to a request sent
	 * before that can be told apart (see `sessionFencedFetch`).
	 */
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
	 * The session was replaced elsewhere (at `revision`): drop what this
	 * storage holds and read the current session. A storage already at that
	 * revision has nothing to do.
	 */
	refresh(revision?: number): Promise<void>;
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
	persistence: SessionPersistence | null
): KeychainSessionStorage {
	let cache = parseBlob(initial?.value ?? null);
	let revision = initial?.revision ?? 0;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let dirty = false;
	let suspended = false;
	let discarded = false;
	// Set when a replaced session could not be read back: this storage no
	// longer knows the current revision, so it stops writing.
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

	/** Take the entry as it is now, replacing whatever this storage held. */
	async function adoptCurrent(): Promise<void> {
		const current = await persistence!.read(accountKey);
		if (discarded) return;
		cancelTimer();
		dirty = false;
		if (!current) {
			retired = true;
			return;
		}
		cache = parseBlob(current.value);
		revision = current.revision;
	}

	function writeNow(): Promise<void> {
		cancelTimer();
		if (!dirty || !canWrite()) return writes;
		dirty = false;
		const blob = JSON.stringify(cache);
		const at = revision;
		writes = writes
			.then(async () => {
				const outcome = await persistence!.write(accountKey, blob, at);
				// The session was replaced since this storage read it: what it
				// holds is the older session, so read the current one instead.
				if (outcome === 'stale') await adoptCurrent();
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
		get revision() {
			return revision;
		},
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
		refresh(at) {
			if (!persistence || discarded) return writes;
			writes = writes
				.then(async () => {
					if (at !== undefined && at === revision) return;
					await adoptCurrent();
				})
				.catch(() => {});
			return writes;
		},
	};
}

/**
 * The storage of the workspace this webview is signed in to, set by the boot
 * hydration (`loadWorkspaces`). A workspace switch reloads the webview, so this
 * is set at most once per page load.
 */
let activeStorage: KeychainSessionStorage | null = null;

export function setActiveKeychainStorage(storage: KeychainSessionStorage | null): void {
	activeStorage = storage;
}

export function getActiveKeychainStorage(): KeychainSessionStorage | null {
	return activeStorage;
}
