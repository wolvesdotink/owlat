import { describe, expect, it } from 'vitest';
import {
	isLegacyOfflineCacheNamespace,
	offlineCacheNamespace,
	readCacheNamespaceOf,
	wipeOfflineReadCache,
} from '../postboxOfflineCacheScope';
import type { OfflineKvDriver } from '../postboxOfflineStore';

function memoryDriver(entries: Record<string, unknown>, failOn?: string) {
	const kv = new Map(Object.entries(entries));
	const driver: OfflineKvDriver = {
		get: async <T>(key: string) => kv.get(key) as T | undefined,
		set: async (key, value) => void kv.set(key, value),
		delete: async (key) => {
			if (key === failOn) throw new Error('blocked');
			kv.delete(key);
		},
		keys: async () => [...kv.keys()],
		clear: async () => kv.clear(),
	};
	return { kv, driver };
}

describe('offlineCacheNamespace', () => {
	it('joins user and mailbox, and is null while either is unknown', () => {
		expect(offlineCacheNamespace('u1', 'm1')).toBe('u1~m1');
		expect(offlineCacheNamespace(null, 'm1')).toBeNull();
		expect(offlineCacheNamespace('u1', undefined)).toBeNull();
		expect(offlineCacheNamespace('', 'm1')).toBeNull();
	});

	it('gives two members of one team mailbox different namespaces', () => {
		expect(offlineCacheNamespace('u1', 'team')).not.toBe(offlineCacheNamespace('u2', 'team'));
	});
});

describe('readCacheNamespaceOf', () => {
	it('reads the namespace of every read-cache key family', () => {
		expect(readCacheNamespaceOf('threads:u1~m1:inbox')).toBe('u1~m1');
		expect(readCacheNamespaceOf('threads-meta:u1~m1:inbox')).toBe('u1~m1');
		expect(readCacheNamespaceOf('body:u1~m1:msg')).toBe('u1~m1');
		expect(readCacheNamespaceOf('body-index:u1~m1')).toBe('u1~m1');
		expect(readCacheNamespaceOf('folders:u1~m1')).toBe('u1~m1');
		expect(readCacheNamespaceOf('folders-meta:m1')).toBe('m1');
	});

	it('ignores the outbox, draft mirrors and unknown keys', () => {
		expect(readCacheNamespaceOf('outbox:m1:q1')).toBeNull();
		expect(readCacheNamespaceOf('draft-mirror:m1:new')).toBeNull();
		expect(readCacheNamespaceOf('draft-mirror-index:m1')).toBeNull();
		expect(readCacheNamespaceOf('draft-mirror-dead:m1:new')).toBeNull();
		expect(readCacheNamespaceOf('something')).toBeNull();
	});

	it('tells the pre-user namespaces apart', () => {
		expect(isLegacyOfflineCacheNamespace('m1')).toBe(true);
		expect(isLegacyOfflineCacheNamespace('u1~m1')).toBe(false);
	});
});

describe('wipeOfflineReadCache', () => {
	const entries = {
		'threads:u1~m1:inbox': [],
		'body:u2~m1:msg': {},
		'folders:m1': [],
		'outbox:m1:q1': {},
		'draft-mirror:m1:new': {},
	};

	it('deletes every read-cache key and nothing else', async () => {
		const { kv, driver } = memoryDriver(entries);
		expect(await wipeOfflineReadCache(driver)).toBe(3);
		expect([...kv.keys()].sort()).toEqual(['draft-mirror:m1:new', 'outbox:m1:q1']);
	});

	it('limits itself to the namespaces that match', async () => {
		const { kv, driver } = memoryDriver(entries);
		await wipeOfflineReadCache(driver, isLegacyOfflineCacheNamespace);
		expect(kv.has('folders:m1')).toBe(false);
		expect(kv.has('threads:u1~m1:inbox')).toBe(true);
		expect(kv.has('body:u2~m1:msg')).toBe(true);
	});

	it('keeps going past a key that will not delete', async () => {
		const { kv, driver } = memoryDriver(entries, 'threads:u1~m1:inbox');
		expect(await wipeOfflineReadCache(driver)).toBe(2);
		expect(kv.has('body:u2~m1:msg')).toBe(false);
		expect(kv.has('folders:m1')).toBe(false);
	});
});
