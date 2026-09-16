import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	configureKeychainStorage,
	currentKeychainAccount,
	keychainStorage,
	resetKeychainStorage,
	snapshotKeychain,
} from '../keychainStorage';

describe('keychainStorage — re-pointing the cache between workspaces', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetKeychainStorage();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('tracks which account the cache is bound to', () => {
		expect(currentKeychainAccount()).toBeNull();
		configureKeychainStorage('owlat-ws:a', null, vi.fn());
		expect(currentKeychainAccount()).toBe('owlat-ws:a');
	});

	it('seeds the cache from the persisted blob', () => {
		configureKeychainStorage('owlat-ws:a', '{"k":"v"}', vi.fn());
		expect(keychainStorage.getItem('k')).toBe('v');
		expect(JSON.parse(snapshotKeychain())).toEqual({ k: 'v' });
	});

	// The flush timer closes over the account key it was scheduled for, but
	// serializes the cache as it is when it FIRES. Re-pointing without cancelling
	// therefore writes the NEW workspace's secrets into the OLD workspace's
	// keychain entry.
	it('cancels a queued flush when the cache is re-pointed', () => {
		const persistA = vi.fn();
		configureKeychainStorage('owlat-ws:a', null, persistA);
		keychainStorage.setItem('session', 'secret-a');

		const persistB = vi.fn();
		configureKeychainStorage('owlat-ws:b', null, persistB);
		keychainStorage.setItem('session', 'secret-b');

		vi.runAllTimers();

		expect(persistA).not.toHaveBeenCalled();
		expect(persistB).toHaveBeenCalledTimes(1);
		expect(persistB).toHaveBeenCalledWith('owlat-ws:b', JSON.stringify({ session: 'secret-b' }));
	});

	// Used to undo a handshake whose workspace is being abandoned: unlike
	// clearKeychainStorage it must NOT schedule a write, which would race the
	// keychain delete that follows it.
	it('unbinds without scheduling a write', () => {
		const persist = vi.fn();
		configureKeychainStorage('owlat-ws:a', null, persist);
		keychainStorage.setItem('session', 'secret');

		resetKeychainStorage();
		vi.runAllTimers();

		expect(persist).not.toHaveBeenCalled();
		expect(currentKeychainAccount()).toBeNull();
		expect(snapshotKeychain()).toBe('{}');
	});
});
