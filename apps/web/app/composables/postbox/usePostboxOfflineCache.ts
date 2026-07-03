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
 * Deep plain-copy for values headed to IndexedDB's structured-clone boundary.
 * Convex query results are reactive proxies; passing one straight to
 * structured-clone throws and permanently disables the cache, so we strip all
 * reactivity to a plain JSON snapshot first.
 */
function toPlain<T>(value: readonly T[]): T[] {
	try {
		return JSON.parse(JSON.stringify(value)) as T[];
	} catch {
		return [...value];
	}
}

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

/**
 * @param mailboxId Active mailbox id — used to namespace every cached key so one
 *   account's cache is never served to another on a shared device. Persist/load
 *   of threads and bodies are no-ops without it (e.g. the settings screen, which
 *   only toggles the preference and clears the whole store).
 */
export function usePostboxOfflineCache(mailboxId?: MaybeRefOrGetter<string | undefined>) {
	const { isDesktop } = useDesktopContext();

	/** The cache namespace: the active mailboxId, or null when none is bound. */
	const namespace = computed(() => {
		const id = toValue(mailboxId);
		return id ? String(id) : null;
	});

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
	const canPersist = computed(() => IS_CLIENT && enabled.value && !!store && !!namespace.value);

	// ── Best-effort persist/load wrappers (all no-op when disabled) ───────
	async function persistThreads<T>(folderRole: string, rows: readonly T[]): Promise<void> {
		const ns = namespace.value;
		if (!canPersist.value || !store || !ns) return;
		// Deep plain-copy so a reactive Convex proxy never hits structured-clone
		// (a clone failure would permanently disable the whole cache for the
		// session). toRaw alone leaves nested proxies, so round-trip through JSON.
		await store.saveThreads(ns, folderRole, toPlain(rows));
		syncDisabled();
	}

	async function loadThreads<T>(folderRole: string): Promise<T[]> {
		const ns = namespace.value;
		if (!enabled.value || !store || !ns) return [];
		return store.loadThreads<T>(ns, folderRole);
	}

	async function persistBody(messageId: string, srcdoc: string): Promise<void> {
		const ns = namespace.value;
		if (!canPersist.value || !store || !ns) return;
		await store.saveBody(ns, messageId, srcdoc);
		syncDisabled();
	}

	async function loadBody(messageId: string): Promise<OfflineBodyEntry | null> {
		const ns = namespace.value;
		if (!enabled.value || !store || !ns) return null;
		return store.loadBody(ns, messageId);
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
		persistThreads,
		loadThreads,
		persistBody,
		loadBody,
		clearCache,
	};
}
