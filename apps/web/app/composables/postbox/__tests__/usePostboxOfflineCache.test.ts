/**
 * usePostboxOfflineCache: the device-local "Store recent mail on this device"
 * preference, connectivity, and the best-effort persist wrappers. The store is
 * mocked so these assertions cover the gating/settings behavior only (the data
 * layer is covered by postboxOfflineStore.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';

// A controllable fake store the composable talks to.
const fakeStore = {
	writesDisabled: false,
	saveThreads: vi.fn(async () => {}),
	loadThreads: vi.fn(async () => [] as unknown[]),
	saveBody: vi.fn(async () => {}),
	loadBody: vi.fn(async () => null),
	clear: vi.fn(async () => {
		fakeStore.writesDisabled = false;
	}),
	reenableWrites: vi.fn(() => {
		fakeStore.writesDisabled = false;
	}),
};

// The raw key/value driver under both stores: the sign-out wipe and the legacy
// purge work on keys directly.
const kv = new Map<string, unknown>();
const fakeDriver = {
	get: vi.fn(async (key: string) => kv.get(key)),
	set: vi.fn(async (key: string, value: unknown) => void kv.set(key, value)),
	delete: vi.fn(async (key: string) => void kv.delete(key)),
	keys: vi.fn(async () => [...kv.keys()]),
	clear: vi.fn(async () => kv.clear()),
};

// The signed-in user and the active mailbox together namespace the cache;
// persist/load are no-ops without both.
const USER = 'user-a';
const MBX = 'mbx-test';
const NS = `${USER}~${MBX}`;
const authUser = ref<{ id: string } | null>({ id: USER });

// The folder rail cache is its own module over the same driver.
const fakeFolderStore = {
	saveFolders: vi.fn(async () => {}),
	loadFolders: vi.fn(async () => [] as unknown[]),
	loadFoldersMeta: vi.fn(async () => null),
};

vi.mock('~/utils/postboxOfflineStore', () => ({
	getPostboxOfflineStore: () => fakeStore,
	getOfflineKvDriver: () => fakeDriver,
}));

vi.mock('~/utils/postboxOfflineFolderStore', () => ({
	getPostboxOfflineFolderStore: () => fakeFolderStore,
}));

import {
	usePostboxOfflineCache,
	__resetPostboxOfflineCacheState,
	wipePostboxOfflineReadCache,
	OFFLINE_WRITE_IDLE_TIMEOUT_MS,
	SIGN_OUT_WIPE_TIMEOUT_MS,
} from '../usePostboxOfflineCache';
import { IDLE_FALLBACK_DELAY_MS } from '~/lib/scheduleIdle';

let desktop = false;

beforeEach(() => {
	desktop = false;
	fakeStore.writesDisabled = false;
	[
		...Object.values(fakeStore),
		...Object.values(fakeFolderStore),
		...Object.values(fakeDriver),
	].forEach((v) => {
		if (typeof v === 'function' && 'mockClear' in v) (v as ReturnType<typeof vi.fn>).mockClear();
	});
	kv.clear();
	authUser.value = { id: USER };
	localStorage.clear();
	__resetPostboxOfflineCacheState();
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(desktop) }));
	vi.stubGlobal('useAuth', () => ({ user: authUser }));
});

describe('usePostboxOfflineCache — enabled preference', () => {
	it('defaults ON in the desktop shell', () => {
		desktop = true;
		const { enabled } = usePostboxOfflineCache();
		expect(enabled.value).toBe(true);
	});

	it('defaults ON in the browser too', () => {
		desktop = false;
		const { enabled } = usePostboxOfflineCache();
		expect(enabled.value).toBe(true);
	});

	it('an explicit saved choice overrides the default', () => {
		desktop = true; // would default ON…
		localStorage.setItem('owlat:postbox:offline-cache-enabled', '0'); // …but user said OFF
		const { enabled } = usePostboxOfflineCache();
		expect(enabled.value).toBe(false);
	});

	it('a browser the user switched off stays off', async () => {
		desktop = false;
		localStorage.setItem('owlat:postbox:offline-cache-enabled', '0');
		const { enabled, persistThreads } = usePostboxOfflineCache(MBX);
		expect(enabled.value).toBe(false);
		await persistThreads('inbox', [{ _id: 'a' }]);
		expect(fakeStore.saveThreads).not.toHaveBeenCalled();
	});

	it('setEnabled persists the choice to localStorage', () => {
		const { enabled, setEnabled } = usePostboxOfflineCache();
		setEnabled(true);
		expect(enabled.value).toBe(true);
		expect(localStorage.getItem('owlat:postbox:offline-cache-enabled')).toBe('1');
	});

	it('turning the cache OFF wipes the device store', () => {
		desktop = true;
		const { setEnabled } = usePostboxOfflineCache();
		setEnabled(false);
		expect(fakeStore.clear).toHaveBeenCalled();
	});
});

/** The user's explicit "off", as the settings switch stores it. */
function switchedOff() {
	localStorage.setItem('owlat:postbox:offline-cache-enabled', '0');
}

describe('usePostboxOfflineCache — persist gating', () => {
	it('does not persist while the preference is OFF', async () => {
		switchedOff();
		const { persistThreads } = usePostboxOfflineCache(MBX);
		await persistThreads('inbox', [{ _id: 'a' }]);
		expect(fakeStore.saveThreads).not.toHaveBeenCalled();
	});

	it('persists in a browser by default, namespaced by user + mailbox', async () => {
		desktop = false;
		const { persistThreads } = usePostboxOfflineCache(MBX);
		await persistThreads('inbox', [{ _id: 'a' }]);
		expect(fakeStore.saveThreads).toHaveBeenCalledWith(NS, 'inbox', [{ _id: 'a' }]);
	});

	it('keeps two members of the same mailbox apart', async () => {
		const { persistThreads, loadThreads } = usePostboxOfflineCache(MBX);
		await persistThreads('inbox', [{ _id: 'a' }]);
		authUser.value = { id: 'user-b' };
		await persistThreads('inbox', [{ _id: 'b' }]);
		await loadThreads('inbox');

		expect(fakeStore.saveThreads).toHaveBeenNthCalledWith(1, NS, 'inbox', [{ _id: 'a' }]);
		expect(fakeStore.saveThreads).toHaveBeenNthCalledWith(2, `user-b~${MBX}`, 'inbox', [
			{ _id: 'b' },
		]);
		expect(fakeStore.loadThreads).toHaveBeenCalledWith(`user-b~${MBX}`, 'inbox');
	});

	it('neither reads nor writes without a signed-in user', async () => {
		authUser.value = null;
		const cache = usePostboxOfflineCache(MBX);
		await cache.persistThreads('inbox', [{ _id: 'a' }]);
		await cache.persistBody('m1', '<p>hi</p>');
		expect(await cache.loadThreads('inbox')).toEqual([]);
		expect(await cache.loadBody('m1')).toBeNull();
		expect(fakeStore.saveThreads).not.toHaveBeenCalled();
		expect(fakeStore.saveBody).not.toHaveBeenCalled();
		expect(fakeStore.loadThreads).not.toHaveBeenCalled();
		expect(fakeStore.loadBody).not.toHaveBeenCalled();
	});

	it('does not persist without an active mailbox (no namespace)', async () => {
		desktop = true;
		const { persistThreads } = usePostboxOfflineCache();
		await persistThreads('inbox', [{ _id: 'a' }]);
		expect(fakeStore.saveThreads).not.toHaveBeenCalled();
	});

	it('surfaces the store writes-disabled (quota) flag after a persist', async () => {
		desktop = true;
		const cache = usePostboxOfflineCache(MBX);
		expect(cache.writesDisabled.value).toBe(false);
		fakeStore.writesDisabled = true; // simulate a quota rejection inside the store
		await cache.persistThreads('inbox', [{ _id: 'a' }]);
		expect(cache.writesDisabled.value).toBe(true);
	});

	it('persists the folder rail under the same preference and namespace', async () => {
		desktop = true;
		const { persistFolders } = usePostboxOfflineCache(MBX);
		await persistFolders([{ _id: 'f1', name: 'Inbox' }]);
		expect(fakeFolderStore.saveFolders).toHaveBeenCalledWith(NS, [{ _id: 'f1', name: 'Inbox' }]);
	});

	it('does not cache the folder rail while the preference is OFF', async () => {
		switchedOff();
		const cache = usePostboxOfflineCache(MBX);
		await cache.persistFolders([{ _id: 'f1', name: 'Inbox' }]);
		expect(await cache.loadFolders()).toEqual([]);
		expect(await cache.loadFoldersMeta()).toBeNull();
		expect(fakeFolderStore.saveFolders).not.toHaveBeenCalled();
		expect(fakeFolderStore.loadFolders).not.toHaveBeenCalled();
	});

	it('loadThreads is empty while the preference is OFF', async () => {
		switchedOff();
		const { loadThreads } = usePostboxOfflineCache(MBX);
		expect(await loadThreads('inbox')).toEqual([]);
		expect(fakeStore.loadThreads).not.toHaveBeenCalled();
	});
});

describe('usePostboxOfflineCache — idle, coalesced writes', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
	});

	it('keeps the clone and the write out of the pushing task', async () => {
		desktop = true;
		const { persistThreads } = usePostboxOfflineCache(MBX);
		const done = persistThreads('inbox', [{ _id: 'a' }]);

		await Promise.resolve();
		expect(fakeStore.saveThreads).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(IDLE_FALLBACK_DELAY_MS);
		await done;
		expect(fakeStore.saveThreads).toHaveBeenCalledWith(NS, 'inbox', [{ _id: 'a' }]);
	});

	it('coalesces a burst of pushes into one write of the newest rows', async () => {
		desktop = true;
		const { persistThreads } = usePostboxOfflineCache(MBX);
		const pushes = [
			persistThreads('inbox', [{ _id: 'a' }]),
			persistThreads('inbox', [{ _id: 'a' }, { _id: 'b' }]),
			persistThreads('inbox', [{ _id: 'c' }]),
		];

		await vi.advanceTimersByTimeAsync(IDLE_FALLBACK_DELAY_MS);
		await Promise.all(pushes);

		expect(fakeStore.saveThreads).toHaveBeenCalledTimes(1);
		expect(fakeStore.saveThreads).toHaveBeenCalledWith(NS, 'inbox', [{ _id: 'c' }]);
	});

	it('writes each folder and the rail in their own slot', async () => {
		desktop = true;
		const cache = usePostboxOfflineCache(MBX);
		const pushes = [
			cache.persistThreads('inbox', [{ _id: 'a' }]),
			cache.persistThreads('sent', [{ _id: 's' }]),
			cache.persistFolders([{ _id: 'f1' }]),
			cache.persistFolders([{ _id: 'f1' }, { _id: 'f2' }]),
		];

		await vi.advanceTimersByTimeAsync(IDLE_FALLBACK_DELAY_MS);
		await Promise.all(pushes);

		expect(fakeStore.saveThreads).toHaveBeenCalledTimes(2);
		expect(fakeStore.saveThreads).toHaveBeenCalledWith(NS, 'inbox', [{ _id: 'a' }]);
		expect(fakeStore.saveThreads).toHaveBeenCalledWith(NS, 'sent', [{ _id: 's' }]);
		expect(fakeFolderStore.saveFolders).toHaveBeenCalledTimes(1);
		expect(fakeFolderStore.saveFolders).toHaveBeenCalledWith(NS, [{ _id: 'f1' }, { _id: 'f2' }]);
	});

	it('uses requestIdleCallback with a deadline where the browser has it', async () => {
		desktop = true;
		// Built first, so its one-off legacy purge takes the timer path.
		const { persistThreads } = usePostboxOfflineCache(MBX);
		const idle: Array<{ cb: () => void; timeout?: number }> = [];
		// happy-dom has no requestIdleCallback (like WebKit); give it one.
		(window as { requestIdleCallback?: unknown }).requestIdleCallback = (
			cb: () => void,
			opts?: { timeout: number }
		) => idle.push({ cb, timeout: opts?.timeout });
		const done = persistThreads('inbox', [{ _id: 'a' }]);

		// Nothing runs until the browser calls back, however long that takes.
		await vi.advanceTimersByTimeAsync(OFFLINE_WRITE_IDLE_TIMEOUT_MS * 5);
		expect(fakeStore.saveThreads).not.toHaveBeenCalled();
		expect(idle).toHaveLength(1);
		expect(idle[0]?.timeout).toBe(OFFLINE_WRITE_IDLE_TIMEOUT_MS);

		idle[0]?.cb();
		await done;
		expect(fakeStore.saveThreads).toHaveBeenCalledTimes(1);
	});

	it('drops a queued write when the cache is switched off before it runs', async () => {
		desktop = true;
		const cache = usePostboxOfflineCache(MBX);
		const done = cache.persistThreads('inbox', [{ _id: 'a' }]);

		cache.setEnabled(false);
		await vi.advanceTimersByTimeAsync(IDLE_FALLBACK_DELAY_MS);
		await done;

		expect(fakeStore.clear).toHaveBeenCalled();
		expect(fakeStore.saveThreads).not.toHaveBeenCalled();
	});
});

describe('usePostboxOfflineCache — connectivity', () => {
	it('reflects navigator.onLine and reacts to offline/online events', async () => {
		const { isOnline, isOffline } = usePostboxOfflineCache();
		expect(isOnline.value).toBe(true);
		expect(isOffline.value).toBe(false);

		window.dispatchEvent(new Event('offline'));
		expect(isOffline.value).toBe(true);

		window.dispatchEvent(new Event('online'));
		expect(isOffline.value).toBe(false);
	});
});

describe('usePostboxOfflineCache — sign-out wipe', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('deletes every read-cache key and keeps queued sends and draft mirrors', async () => {
		kv.set(`threads:${NS}:inbox`, [{ _id: 'a' }]);
		kv.set(`threads-meta:${NS}:inbox`, { savedAt: 1 });
		kv.set(`body:user-b~${MBX}:m1`, { srcdoc: '<p>b</p>', cachedAt: 1 });
		kv.set(`body-index:user-b~${MBX}`, ['m1']);
		kv.set(`folders:${NS}`, [{ _id: 'f1' }]);
		kv.set(`outbox:${MBX}:q1`, { id: 'q1' });
		kv.set(`draft-mirror:${MBX}:new`, { body: 'unsent' });

		await wipePostboxOfflineReadCache();

		expect([...kv.keys()].sort()).toEqual([`draft-mirror:${MBX}:new`, `outbox:${MBX}:q1`]);
		expect(fakeStore.reenableWrites).toHaveBeenCalled();
	});

	it('drops a row write still waiting for idle time', async () => {
		const cache = usePostboxOfflineCache(MBX);
		const done = cache.persistThreads('inbox', [{ _id: 'a' }]);

		await wipePostboxOfflineReadCache();
		await vi.advanceTimersByTimeAsync(IDLE_FALLBACK_DELAY_MS);
		await done;

		expect(fakeStore.saveThreads).not.toHaveBeenCalled();
	});

	it('does not hold sign-out hostage to a storage that never answers', async () => {
		fakeDriver.keys.mockImplementationOnce(() => new Promise<string[]>(() => {}));
		let settled = false;
		const wipe = wipePostboxOfflineReadCache().then(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(SIGN_OUT_WIPE_TIMEOUT_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await wipe;
		expect(settled).toBe(true);
	});

	it('clears the writes-disabled state the settings screen shows', async () => {
		const cache = usePostboxOfflineCache(MBX);
		fakeStore.writesDisabled = true;
		await cache.persistBody('m1', '<p>hi</p>');
		expect(cache.writesDisabled.value).toBe(true);

		await wipePostboxOfflineReadCache();

		expect(cache.writesDisabled.value).toBe(false);
	});

	it('purges rows cached before the namespace carried the user, once per session', async () => {
		kv.set(`threads:${MBX}:inbox`, [{ _id: 'old' }]);
		kv.set(`body:${MBX}:m1`, { srcdoc: '<p>old</p>', cachedAt: 1 });
		kv.set(`threads:${NS}:inbox`, [{ _id: 'new' }]);
		kv.set(`outbox:${MBX}:q1`, { id: 'q1' });

		usePostboxOfflineCache(MBX);
		usePostboxOfflineCache(MBX);
		await vi.advanceTimersByTimeAsync(IDLE_FALLBACK_DELAY_MS);

		expect([...kv.keys()].sort()).toEqual([`outbox:${MBX}:q1`, `threads:${NS}:inbox`]);
		expect(fakeDriver.keys).toHaveBeenCalledTimes(1);
	});
});
