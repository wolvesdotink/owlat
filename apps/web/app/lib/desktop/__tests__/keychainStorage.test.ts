import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionEntry } from '@owlat/desktop/src/keychain';
import {
	bindActiveSession,
	createKeychainStorage,
	getActiveKeychainStorage,
	rebindActiveSession,
	setActiveKeychainStorage,
	type SessionPersistence,
} from '../keychainStorage';

/** The entry as read at revision 0. */
const read = (value: string | null): SessionEntry => ({ value, revision: 0 });

type WriteFn = (key: string, blob: string, revision: number) => unknown;

/** A persistence whose writes go to `write` and land; the entry reads as `current`. */
function persistence(
	write: WriteFn = () => {},
	current: () => SessionEntry | null = () => read(null)
): SessionPersistence {
	return {
		write: async (key, blob, revision) => {
			const outcome = await write(key, blob, revision);
			return outcome === 'stale' || outcome === 'failed' ? outcome : 'written';
		},
		read: async () => current(),
	};
}

describe('keychainStorage — one storage per keychain entry', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setActiveKeychainStorage(null);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('seeds the cache from the persisted blob', () => {
		const storage = createKeychainStorage('owlat-ws:a', read('{"k":"v"}'), persistence());
		expect(storage.accountKey).toBe('owlat-ws:a');
		expect(storage.getItem('k')).toBe('v');
		expect(JSON.parse(storage.snapshot())).toEqual({ k: 'v' });
	});

	it('starts clean from a corrupt blob', () => {
		const storage = createKeychainStorage('owlat-ws:a', read('not json'), persistence());
		expect(storage.snapshot()).toBe('{}');
	});

	it('writes changes to its own entry after the debounce, once', async () => {
		const persist = vi.fn();
		const storage = createKeychainStorage('owlat-ws:a', null, persistence(persist));
		storage.setItem('session', 'one');
		storage.setItem('session', 'two');
		storage.removeItem('other');

		expect(persist).not.toHaveBeenCalled();
		await vi.runAllTimersAsync();

		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist).toHaveBeenCalledWith('owlat-ws:a', JSON.stringify({ session: 'two' }), 0);
	});

	it('keeps two workspaces apart: neither sees nor writes the other', async () => {
		const persistA = vi.fn();
		const persistB = vi.fn();
		const a = createKeychainStorage('owlat-ws:a', read('{"session":"a"}'), persistence(persistA));
		const b = createKeychainStorage('owlat-ws:b', null, persistence(persistB));

		b.setItem('session', 'b');
		await vi.runAllTimersAsync();

		expect(a.getItem('session')).toBe('a');
		expect(persistA).not.toHaveBeenCalled();
		expect(persistB).toHaveBeenCalledWith('owlat-ws:b', JSON.stringify({ session: 'b' }), 0);
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
		const storage = createKeychainStorage('owlat-ws:a', null, persistence(persist));
		storage.setItem('session', 'fresh');

		await storage.flush();

		expect(landed).toBe(true);
		expect(persist).toHaveBeenCalledWith('owlat-ws:a', JSON.stringify({ session: 'fresh' }), 0);
		// Nothing left for the debounce to write.
		vi.runAllTimers();
		expect(persist).toHaveBeenCalledTimes(1);
	});

	it('flush with nothing changed writes nothing', async () => {
		const persist = vi.fn();
		const storage = createKeychainStorage('owlat-ws:a', read('{"k":"v"}'), persistence(persist));
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
		const storage = createKeychainStorage('owlat-ws:a', null, persistence(persist));
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
		const storage = createKeychainStorage('owlat-ws:a', null, persistence(persist));
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
		expect(persist).toHaveBeenLastCalledWith('owlat-ws:a', JSON.stringify({ session: 'two' }), 0);
	});

	it('discard forgets the session without writing the emptied cache', async () => {
		const persist = vi.fn();
		const storage = createKeychainStorage(
			'owlat-ws:a',
			read('{"session":"a"}'),
			persistence(persist)
		);
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

	it('writes against the revision it read', async () => {
		const persist = vi.fn();
		const storage = createKeychainStorage(
			'owlat-ws:a',
			{ value: '{"session":"a"}', revision: 4 },
			persistence(persist)
		);
		storage.setItem('session', 'refreshed');
		await storage.flush();
		expect(persist).toHaveBeenCalledWith('owlat-ws:a', JSON.stringify({ session: 'refreshed' }), 4);
	});

	// Another window signed in again: this one holds the older session. Its
	// write is refused, and it never writes again.
	it('retires itself and reports it when its write is refused as stale', async () => {
		const persist = vi.fn(() => 'stale');
		const onStale = vi.fn();
		const storage = createKeychainStorage(
			'owlat-ws:a',
			read('{"session":"old"}'),
			persistence(persist),
			{ onStale }
		);
		storage.setItem('session', 'old, refreshed');
		await storage.flush();
		expect(onStale).toHaveBeenCalledTimes(1);

		storage.setItem('session', 'old, again');
		vi.runAllTimers();
		await storage.flush();
		expect(persist).toHaveBeenCalledTimes(1);
		expect(onStale).toHaveBeenCalledTimes(1);
	});

	it('a retired storage keeps working in memory and writes nothing', async () => {
		const persist = vi.fn();
		const storage = createKeychainStorage('owlat-ws:a', read(null), persistence(persist));
		storage.setItem('session', 'pending');
		storage.retire();
		storage.setItem('session', 'late answer');
		vi.runAllTimers();
		await storage.flush();
		expect(storage.getItem('session')).toBe('late answer');
		expect(persist).not.toHaveBeenCalled();
	});

	describe('rebindActiveSession', () => {
		it('retires the bound storage and binds a new one to the current session', async () => {
			let entry: SessionEntry = { value: '{"session":"old"}', revision: 0 };
			const persist = vi.fn();
			const p = persistence(persist, () => entry);
			const old = bindActiveSession('owlat-ws:a', entry, p);
			old.setItem('session', 'old, unsaved');

			entry = { value: '{"session":"new"}', revision: 1 };
			await rebindActiveSession('owlat-ws:a', 1);

			const bound = getActiveKeychainStorage();
			expect(bound).not.toBe(old);
			expect(bound?.revision).toBe(1);
			expect(bound?.getItem('session')).toBe('new');
			// The older session's change, and anything the old client still writes,
			// stays in the retired storage.
			old.setItem('session', 'late answer');
			vi.runAllTimers();
			await old.flush();
			expect(persist).not.toHaveBeenCalled();
			expect(bound?.getItem('session')).toBe('new');
		});

		it('leaves a storage alone that already holds that revision, or another account', async () => {
			const p = persistence(undefined, () => ({ value: '{}', revision: 2 }));
			const bound = bindActiveSession('owlat-ws:a', { value: '{}', revision: 2 }, p);
			await rebindActiveSession('owlat-ws:a', 2);
			await rebindActiveSession('owlat-ws:b', 3);
			expect(getActiveKeychainStorage()).toBe(bound);
		});

		it('rebinds after a write refused as stale', async () => {
			let entry: SessionEntry = { value: '{"session":"old"}', revision: 0 };
			const p = persistence(
				(_key, _blob, revision) => (revision === entry.revision ? 'written' : 'stale'),
				() => entry
			);
			const old = bindActiveSession('owlat-ws:a', entry, p);
			entry = { value: '{"session":"new"}', revision: 1 };
			old.setItem('session', 'old, refreshed');
			await old.flush();
			await vi.waitFor(() => expect(getActiveKeychainStorage()).not.toBe(old));
			expect(getActiveKeychainStorage()?.getItem('session')).toBe('new');
		});

		it('keeps the retired storage bound when the session cannot be read', async () => {
			const persist = vi.fn();
			const old = bindActiveSession(
				'owlat-ws:a',
				read('{"session":"old"}'),
				persistence(persist, () => null)
			);
			await rebindActiveSession('owlat-ws:a', 1);
			expect(getActiveKeychainStorage()).toBe(old);
			old.setItem('session', 'changed');
			vi.runAllTimers();
			await old.flush();
			expect(persist).not.toHaveBeenCalled();
		});
	});

	it('records the active workspace storage', () => {
		expect(getActiveKeychainStorage()).toBeNull();
		const storage = createKeychainStorage('owlat-ws:a', null, persistence());
		setActiveKeychainStorage(storage);
		expect(getActiveKeychainStorage()).toBe(storage);
	});
});
