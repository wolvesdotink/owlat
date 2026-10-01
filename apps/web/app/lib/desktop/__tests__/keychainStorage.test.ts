import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createKeychainStorage,
	getActiveKeychainStorage,
	setActiveKeychainStorage,
} from '../keychainStorage';

describe('keychainStorage — one storage per keychain entry', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setActiveKeychainStorage(null);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('seeds the cache from the persisted blob', () => {
		const storage = createKeychainStorage('owlat-ws:a', '{"k":"v"}', vi.fn());
		expect(storage.accountKey).toBe('owlat-ws:a');
		expect(storage.getItem('k')).toBe('v');
		expect(JSON.parse(storage.snapshot())).toEqual({ k: 'v' });
	});

	it('starts clean from a corrupt blob', () => {
		const storage = createKeychainStorage('owlat-ws:a', 'not json', vi.fn());
		expect(storage.snapshot()).toBe('{}');
	});

	it('writes changes to its own entry after the debounce, once', async () => {
		const persist = vi.fn();
		const storage = createKeychainStorage('owlat-ws:a', null, persist);
		storage.setItem('session', 'one');
		storage.setItem('session', 'two');
		storage.removeItem('other');

		expect(persist).not.toHaveBeenCalled();
		await vi.runAllTimersAsync();

		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist).toHaveBeenCalledWith('owlat-ws:a', JSON.stringify({ session: 'two' }));
	});

	it('keeps two workspaces apart: neither sees nor writes the other', async () => {
		const persistA = vi.fn();
		const persistB = vi.fn();
		const a = createKeychainStorage('owlat-ws:a', '{"session":"a"}', persistA);
		const b = createKeychainStorage('owlat-ws:b', null, persistB);

		b.setItem('session', 'b');
		await vi.runAllTimersAsync();

		expect(a.getItem('session')).toBe('a');
		expect(persistA).not.toHaveBeenCalled();
		expect(persistB).toHaveBeenCalledWith('owlat-ws:b', JSON.stringify({ session: 'b' }));
	});

	it('stays in memory without a persister', async () => {
		const storage = createKeychainStorage('owlat-ws:a', null, null);
		storage.setItem('session', 'pending');
		vi.runAllTimers();
		await storage.flush();
		expect(storage.getItem('session')).toBe('pending');
	});

	it('flush writes a pending change now and waits for it', async () => {
		let landed = false;
		const persist = vi.fn(async () => {
			await Promise.resolve();
			landed = true;
		});
		const storage = createKeychainStorage('owlat-ws:a', null, persist);
		storage.setItem('session', 'fresh');

		await storage.flush();

		expect(landed).toBe(true);
		expect(persist).toHaveBeenCalledWith('owlat-ws:a', JSON.stringify({ session: 'fresh' }));
		// Nothing left for the debounce to write.
		vi.runAllTimers();
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it('flush with nothing changed writes nothing', async () => {
		const persist = vi.fn();
		const storage = createKeychainStorage('owlat-ws:a', '{"k":"v"}', persist);
		await storage.flush();
		expect(persist).not.toHaveBeenCalled();
	});

	it('writes in order, so an older blob never lands after a newer one', async () => {
		const landed: string[] = [];
		let releaseFirst!: () => void;
		const persist = vi.fn((_key: string, blob: string) =>
			blob.includes('one')
				? new Promise<void>((resolve) => {
						releaseFirst = () => {
							landed.push(blob);
							resolve();
						};
					})
				: void landed.push(blob)
		);
		const storage = createKeychainStorage('owlat-ws:a', null, persist);
		storage.setItem('session', 'one');
		const first = storage.flush();
		storage.setItem('session', 'two');
		const second = storage.flush();

		// The first write has started and is still running.
		await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
		releaseFirst();
		await Promise.all([first, second]);

		expect(landed.map((b) => JSON.parse(b).session)).toEqual(['one', 'two']);
	});

	it('suspend waits for a started write and holds later ones until resumed', async () => {
		let releaseWrite!: () => void;
		const persist = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseWrite = resolve;
				})
		);
		const storage = createKeychainStorage('owlat-ws:a', null, persist);
		storage.setItem('session', 'one');
		void storage.flush();

		let suspended = false;
		const suspending = storage.suspend().then((resume) => {
			suspended = true;
			return resume;
		});
		await Promise.resolve();
		expect(suspended).toBe(false);
		releaseWrite();
		const resume = await suspending;

		storage.setItem('session', 'two');
		vi.runAllTimers();
		await storage.flush();
		expect(persist).toHaveBeenCalledTimes(1);

		persist.mockImplementation(async () => {});
		resume();
		await storage.flush();
		expect(persist).toHaveBeenCalledTimes(2);
		expect(persist).toHaveBeenLastCalledWith('owlat-ws:a', JSON.stringify({ session: 'two' }));
	});

	it('discard forgets the session without writing the emptied cache', async () => {
		const persist = vi.fn();
		const storage = createKeychainStorage('owlat-ws:a', '{"session":"a"}', persist);
		storage.setItem('session', 'changed');

		await storage.discard();
		vi.runAllTimers();
		storage.setItem('late', 'write');
		vi.runAllTimers();
		await storage.flush();
		(await storage.suspend())();

		expect(persist).not.toHaveBeenCalled();
		expect(storage.getItem('session')).toBeNull();
	});

	it('records the active workspace storage', () => {
		expect(getActiveKeychainStorage()).toBeNull();
		const storage = createKeychainStorage('owlat-ws:a', null, vi.fn());
		setActiveKeychainStorage(storage);
		expect(getActiveKeychainStorage()).toBe(storage);
	});
});
