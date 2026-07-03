/**
 * usePostboxOfflineCache: the device-local "Store recent mail on this device"
 * preference, connectivity, and the best-effort persist wrappers. The store is
 * mocked so these assertions cover the gating/settings behavior only (the data
 * layer is covered by postboxOfflineStore.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

// A controllable fake store the composable talks to.
const fakeStore = {
	writesDisabled: false,
	saveThreads: vi.fn(async () => {}),
	loadThreads: vi.fn(async () => [] as unknown[]),
	saveFolders: vi.fn(async () => {}),
	loadFolders: vi.fn(async () => null),
	saveBody: vi.fn(async () => {}),
	loadBody: vi.fn(async () => null),
	clear: vi.fn(async () => {
		fakeStore.writesDisabled = false;
	}),
};

vi.mock('~/utils/postboxOfflineStore', () => ({
	getPostboxOfflineStore: () => fakeStore,
}));

import {
	usePostboxOfflineCache,
	__resetPostboxOfflineCacheState,
} from '../usePostboxOfflineCache';

let desktop = false;

beforeEach(() => {
	desktop = false;
	fakeStore.writesDisabled = false;
	Object.values(fakeStore).forEach((v) => {
		if (typeof v === 'function' && 'mockClear' in v) (v as ReturnType<typeof vi.fn>).mockClear();
	});
	localStorage.clear();
	__resetPostboxOfflineCacheState();
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(desktop) }));
});

describe('usePostboxOfflineCache — enabled preference', () => {
	it('defaults ON in the desktop shell', () => {
		desktop = true;
		const { enabled } = usePostboxOfflineCache();
		expect(enabled.value).toBe(true);
	});

	it('defaults OFF in the browser', () => {
		desktop = false;
		const { enabled } = usePostboxOfflineCache();
		expect(enabled.value).toBe(false);
	});

	it('an explicit saved choice overrides the default', () => {
		desktop = true; // would default ON…
		localStorage.setItem('owlat:postbox:offline-cache-enabled', '0'); // …but user said OFF
		const { enabled } = usePostboxOfflineCache();
		expect(enabled.value).toBe(false);
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

describe('usePostboxOfflineCache — persist gating', () => {
	it('does not persist while the preference is OFF', async () => {
		desktop = false;
		const { persistThreads } = usePostboxOfflineCache();
		await persistThreads('inbox', [{ _id: 'a' }]);
		expect(fakeStore.saveThreads).not.toHaveBeenCalled();
	});

	it('persists once the preference is ON', async () => {
		desktop = true;
		const { persistThreads } = usePostboxOfflineCache();
		await persistThreads('inbox', [{ _id: 'a' }]);
		expect(fakeStore.saveThreads).toHaveBeenCalledWith('inbox', [{ _id: 'a' }]);
	});

	it('surfaces the store writes-disabled (quota) flag after a persist', async () => {
		desktop = true;
		const cache = usePostboxOfflineCache();
		expect(cache.writesDisabled.value).toBe(false);
		fakeStore.writesDisabled = true; // simulate a quota rejection inside the store
		await cache.persistThreads('inbox', [{ _id: 'a' }]);
		expect(cache.writesDisabled.value).toBe(true);
	});

	it('loadThreads is empty while the preference is OFF', async () => {
		desktop = false;
		const { loadThreads } = usePostboxOfflineCache();
		expect(await loadThreads('inbox')).toEqual([]);
		expect(fakeStore.loadThreads).not.toHaveBeenCalled();
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
