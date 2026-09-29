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

import { getPostboxOfflineFolderStore } from '~/utils/postboxOfflineFolderStore';
import { getPostboxOfflineStore, type OfflineBodyEntry } from '~/utils/postboxOfflineStore';
import { scheduleIdle } from '~/lib/scheduleIdle';

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
 * How long a queued row write may wait for an idle moment. The list pushes a
 * fresh result on every live update; the clone and the IndexedDB write are
 * background work and must not land in the same task as the render.
 */
export const OFFLINE_WRITE_IDLE_TIMEOUT_MS = 1000;

type Waiter = { resolve: () => void; reject: (error: unknown) => void };
type PendingWrite = { write: () => Promise<void>; waiters: Waiter[] };

/**
 * Row writes waiting for idle time, one per cache slot (mailbox + folder, or
 * mailbox rail). A push onto a slot that is already queued replaces the rows
 * instead of queueing a second write, so a burst of live updates costs one
 * clone and one write. Every caller's promise settles with the write that
 * carried its rows or newer ones.
 */
const pendingWrites = new Map<string, PendingWrite>();

function queueIdleWrite(slot: string, write: () => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const queued = pendingWrites.get(slot);
		if (queued) {
			queued.write = write;
			queued.waiters.push({ resolve, reject });
			return;
		}
		const entry: PendingWrite = { write, waiters: [{ resolve, reject }] };
		pendingWrites.set(slot, entry);
		scheduleIdle(() => {
			// Dropped meanwhile (the cache was cleared); its callers are settled.
			if (pendingWrites.get(slot) !== entry) return;
			pendingWrites.delete(slot);
			entry.write().then(
				() => {
					for (const w of entry.waiters) w.resolve();
				},
				(error: unknown) => {
					for (const w of entry.waiters) w.reject(error);
				}
			);
		}, OFFLINE_WRITE_IDLE_TIMEOUT_MS);
	});
}

/** Forget every queued write (the cache is being wiped), settling its callers. */
function dropPendingWrites(): void {
	for (const entry of pendingWrites.values()) {
		for (const w of entry.waiters) w.resolve();
	}
	pendingWrites.clear();
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
	dropPendingWrites();
}

/**
 * @param mailboxId Active mailbox id — used to namespace every cached key so one
 *   account's cache is never served to another on a shared device. Persist/load
 *   of threads and bodies are no-ops without it (e.g. the settings screen, which
 *   only toggles the preference and clears the whole store).
 */
export function usePostboxOfflineCache(mailboxId?: MaybeRefOrGetter<string | null | undefined>) {
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
		onlineRef = ref(!IS_CLIENT || typeof navigator === 'undefined' ? true : navigator.onLine);
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
	// Same DB and driver, separate module (see postboxOfflineFolderStore.ts).
	// It has no disabled latch of its own: the folder rail is a few KB, so a
	// failure there is swallowed per call rather than closing the whole cache.
	const folderStore = IS_CLIENT ? getPostboxOfflineFolderStore() : null;

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
		// Queued for idle time and coalesced per folder: the deep copy below is
		// the expensive part, and only the newest rows are worth writing.
		return queueIdleWrite(`threads\u0000${ns}\u0000${folderRole}`, async () => {
			// Switched off while queued: turning the cache off wiped it.
			if (!enabled.value) return;
			// Deep plain-copy so a reactive Convex proxy never hits structured-clone
			// (a clone failure would permanently disable the whole cache for the
			// session). toRaw alone leaves nested proxies, so round-trip through JSON.
			await store.saveThreads(ns, folderRole, toPlain(rows));
			syncDisabled();
		});
	}

	async function loadThreads<T>(folderRole: string): Promise<T[]> {
		const ns = namespace.value;
		if (!enabled.value || !store || !ns) return [];
		return store.loadThreads<T>(ns, folderRole);
	}

	async function loadThreadsMeta(folderRole: string) {
		const ns = namespace.value;
		if (!enabled.value || !store || !ns) return null;
		return store.loadThreadsMeta(ns, folderRole);
	}

	async function persistFolders<T>(rows: readonly T[]): Promise<void> {
		const ns = namespace.value;
		if (!canPersist.value || !folderStore || !ns) return;
		return queueIdleWrite(`folders\u0000${ns}`, async () => {
			if (!enabled.value) return;
			// Same structured-clone hazard as the thread rows: a Convex proxy would
			// throw on the way into IndexedDB.
			await folderStore.saveFolders(ns, toPlain(rows));
		});
	}

	async function loadFolders<T>(): Promise<T[]> {
		const ns = namespace.value;
		if (!enabled.value || !folderStore || !ns) return [];
		return folderStore.loadFolders<T>(ns);
	}

	async function loadFoldersMeta() {
		const ns = namespace.value;
		if (!enabled.value || !folderStore || !ns) return null;
		return folderStore.loadFoldersMeta(ns);
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
		// A write still waiting for idle time would put rows straight back.
		dropPendingWrites();
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
		loadThreadsMeta,
		persistFolders,
		loadFolders,
		loadFoldersMeta,
		persistBody,
		loadBody,
		clearCache,
	};
}
