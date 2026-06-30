/**
 * Synchronous storage adapter backed by the OS keychain.
 *
 * `crossDomainClient` requires a *synchronous* `storage` ({ getItem, setItem }),
 * but the OS keychain is async (it goes through Tauri `invoke`). We bridge the
 * gap with a boot-hydrated, in-memory write-through cache:
 *
 *   - the boot plugin reads the active workspace's session blob from the keychain
 *     once and calls `configure()` to seed the cache + register a persister;
 *   - `getItem`/`setItem` operate on the cache synchronously;
 *   - `setItem`/`removeItem` schedule a debounced flush of the whole blob back to
 *     the keychain via the registered (async) persister.
 *
 * The whole cache is serialized as one JSON blob per workspace, so we never need
 * to know `crossDomainClient`'s internal key names (cookie vs local-cache).
 */
type Persister = (accountKey: string, blob: string) => void | Promise<void>;

let cache: Record<string, string> = {};
let accountKey: string | null = null;
let persister: Persister | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
	if (!persister || !accountKey) return;
	if (flushTimer) clearTimeout(flushTimer);
	const key = accountKey;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void persister?.(key, JSON.stringify(cache));
	}, 150);
}

export const keychainStorage = {
	getItem(key: string): string | null {
		return key in cache ? cache[key]! : null;
	},
	setItem(key: string, value: string): void {
		cache[key] = value;
		scheduleFlush();
	},
	removeItem(key: string): void {
		delete cache[key];
		scheduleFlush();
	},
};

/**
 * Seed the cache for a workspace and register the keychain persister.
 * Called by the boot plugin after reading the keychain. `initialBlob` is the
 * previously-persisted JSON blob (or null/empty for a fresh workspace).
 */
export function configureKeychainStorage(
	key: string,
	initialBlob: string | null,
	persist: Persister,
): void {
	accountKey = key;
	persister = persist;
	cache = {};
	if (initialBlob) {
		try {
			const parsed = JSON.parse(initialBlob) as Record<string, string>;
			if (parsed && typeof parsed === 'object') cache = parsed;
		} catch {
			// Corrupt blob — start clean; the next auth flow re-populates it.
			cache = {};
		}
	}
}

/** Drop all stored secrets for the active workspace (sign-out). */
export function clearKeychainStorage(): void {
	cache = {};
	scheduleFlush();
}

/**
 * Current cache serialized as the JSON blob persisted to the keychain. Used to
 * force an immediate, awaitable write before a workspace switch/reload (which
 * would otherwise race the debounced flush).
 */
export function snapshotKeychain(): string {
	return JSON.stringify(cache);
}
