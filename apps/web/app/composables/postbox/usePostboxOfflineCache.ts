/**
 * Device-local control surface for the Postbox offline read cache.
 *
 * This composable owns:
 *   - the per-DEVICE "Store recent mail on this device" preference (localStorage,
 *     NOT a synced Convex setting — the cache is device-scoped). Default ON in
 *     the desktop shell, OFF in a browser, matching the spec.
 *   - live connectivity (`navigator.onLine` + online/offline events),
 *   - best-effort read/write wrappers over the shared {@link PostboxOfflineStore},
 *     gated by the preference, and the reactive "writes disabled" state
 *     (e.g. after a quota rejection) that the settings screen surfaces.
 *
 * Everything here fails soft: with the preference OFF, or IndexedDB unavailable,
 * every persist is a no-op and every load returns empty, so the caller degrades
 * to the online-only UX with no branching of its own.
 */

import {
	getPostboxOfflineStore,
	type OfflineBodyEntry,
} from '~/utils/postboxOfflineStore';

const STORAGE_KEY = 'owlat:postbox:offline-cache-enabled';

/**
 * Client detection that is both SSR-safe (no `window` on the server) and
 * test-friendly (happy-dom provides `window`), unlike Nuxt's compile-time
 * `import.meta.client` which is undefined under vitest.
 */
const IS_CLIENT = typeof window !== 'undefined';

/** Module-scoped reactive singletons so every caller shares one truth. */
let enabledRef: Ref<boolean> | null = null;
let onlineRef: Ref<boolean> | null = null;
let writesDisabledRef: Ref<boolean> | null = null;

/** Test-only: reset the shared reactive state between cases. */
export function __resetPostboxOfflineCacheState() {
	enabledRef = null;
	onlineRef = null;
	writesDisabledRef = null;
}

export function usePostboxOfflineCache() {
	const { isDesktop } = useDesktopContext();

	// ── "Store recent mail on this device" (device-local preference) ──────
	if (!enabledRef) {
		// Default ON on desktop, OFF in the browser; an explicit saved choice wins.
		const stored = IS_CLIENT ? localStorage.getItem(STORAGE_KEY) : null;
		const initial = stored === null ? isDesktop.value : stored === '1';
		enabledRef = ref(initial);
	}
	const enabled = enabledRef;

	function setEnabled(value: boolean) {
		enabled.value = value;
		if (IS_CLIENT) localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
		// Turning the cache OFF wipes whatever is already on the device.
		if (!value) void clearCache();
	}

	// ── Connectivity ─────────────────────────────────────────────────────
	if (!onlineRef) {
		onlineRef = ref(
			!IS_CLIENT || typeof navigator === 'undefined' ? true : navigator.onLine
		);
		if (IS_CLIENT) {
			window.addEventListener('online', () => {
				if (onlineRef) onlineRef.value = true;
			});
			window.addEventListener('offline', () => {
				if (onlineRef) onlineRef.value = false;
			});
		}
	}
	const isOnline = onlineRef;
	const isOffline = computed(() => !isOnline.value);

	// ── Write-disabled (quota) state ─────────────────────────────────────
	if (!writesDisabledRef) writesDisabledRef = ref(false);
	const writesDisabled = writesDisabledRef;

	const store = IS_CLIENT ? getPostboxOfflineStore() : null;

	/** Mirror the store's disabled flag into the reactive settings surface. */
	function syncDisabled() {
		if (store && writesDisabled) writesDisabled.value = store.writesDisabled;
	}

	/** Whether a persist should even be attempted right now. */
	const canPersist = computed(() => IS_CLIENT && enabled.value && !!store);

	// ── Best-effort persist/load wrappers (all no-op when disabled) ───────
	async function persistFolders(folders: unknown): Promise<void> {
		if (!canPersist.value || !store) return;
		await store.saveFolders(folders);
		syncDisabled();
	}

	async function loadFolders<T>(): Promise<T | null> {
		if (!enabled.value || !store) return null;
		return store.loadFolders<T>();
	}

	async function persistThreads<T>(folderRole: string, rows: readonly T[]): Promise<void> {
		if (!canPersist.value || !store) return;
		await store.saveThreads(folderRole, rows);
		syncDisabled();
	}

	async function loadThreads<T>(folderRole: string): Promise<T[]> {
		if (!enabled.value || !store) return [];
		return store.loadThreads<T>(folderRole);
	}

	async function persistBody(messageId: string, srcdoc: string): Promise<void> {
		if (!canPersist.value || !store) return;
		await store.saveBody(messageId, srcdoc);
		syncDisabled();
	}

	async function loadBody(messageId: string): Promise<OfflineBodyEntry | null> {
		if (!enabled.value || !store) return null;
		return store.loadBody(messageId);
	}

	/** Wipe everything this device has cached and clear the disabled flag. */
	async function clearCache(): Promise<void> {
		if (!store) return;
		await store.clear();
		syncDisabled();
	}

	return {
		isDesktop,
		enabled: readonly(enabled),
		setEnabled,
		isOnline: readonly(isOnline),
		isOffline,
		writesDisabled: readonly(writesDisabled),
		canPersist,
		persistFolders,
		loadFolders,
		persistThreads,
		loadThreads,
		persistBody,
		loadBody,
		clearCache,
	};
}
