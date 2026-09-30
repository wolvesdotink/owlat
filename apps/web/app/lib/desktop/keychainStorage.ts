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
 */
type Persister = (accountKey: string, blob: string) => void | Promise<void>;

export interface KeychainSessionStorage {
	/** The keychain entry this storage reads from and writes to. Fixed. */
	readonly accountKey: string;
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
 * A storage for one keychain entry. `initialBlob` is the previously persisted
 * blob (null for a fresh entry). With no `persist`, the storage is memory-only
 * until its owner writes `snapshot()` itself — the connect handshake keeps a
 * session it has not confirmed off the keychain that way.
 */
export function createKeychainStorage(
	accountKey: string,
	initialBlob: string | null,
	persist: Persister | null
): KeychainSessionStorage {
	let cache = parseBlob(initialBlob);
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let dirty = false;
	let suspended = false;
	let discarded = false;
	// Writes are chained so two flushes can never land out of order.
	let writes: Promise<void> = Promise.resolve();

	function cancelTimer(): void {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
	}

	function writeNow(): Promise<void> {
		cancelTimer();
		if (!persist || !dirty || suspended || discarded) return writes;
		dirty = false;
		const blob = JSON.stringify(cache);
		writes = writes.then(() => persist(accountKey, blob)).catch(() => {});
		return writes;
	}

	function changed(): void {
		dirty = true;
		if (!persist || suspended || discarded) return;
		cancelTimer();
		flushTimer = setTimeout(() => {
			flushTimer = null;
			void writeNow();
		}, FLUSH_DEBOUNCE_MS);
	}

	return {
		accountKey,
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
