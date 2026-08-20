import { describe, expect, it } from 'vitest';
import { TtlCache } from '../cache.js';
import { fakeClock } from './fixtures.js';

describe('TtlCache', () => {
	it('returns a value until its TTL elapses, then forgets it', () => {
		const clock = fakeClock();
		const cache = new TtlCache<number>({ now: clock.now, ttlSeconds: 60 });
		cache.set('a', 1);
		clock.advance(59);
		expect(cache.get('a')).toBe(1);
		clock.advance(1);
		expect(cache.get('a')).toBeNull();
	});

	it('drops an expired entry on read rather than holding it forever', () => {
		const clock = fakeClock();
		const cache = new TtlCache<number>({ now: clock.now, ttlSeconds: 10 });
		cache.set('a', 1);
		clock.advance(11);
		expect(cache.size()).toBe(1);
		cache.get('a');
		expect(cache.size()).toBe(0);
	});

	it('stores nothing at all when the TTL is zero or negative', () => {
		const cache = new TtlCache<number>({ now: fakeClock().now, ttlSeconds: 0 });
		cache.set('a', 1);
		expect(cache.get('a')).toBeNull();
		expect(cache.size()).toBe(0);
	});

	it('evicts the oldest write past the size bound', () => {
		const cache = new TtlCache<number>({ now: fakeClock().now, ttlSeconds: 60, maxEntries: 3 });
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('c', 3);
		cache.set('d', 4);
		expect(cache.get('a')).toBeNull();
		expect(cache.get('d')).toBe(4);
		expect(cache.size()).toBe(3);
	});

	it('counts a rewrite as a fresh write for eviction order', () => {
		const cache = new TtlCache<number>({ now: fakeClock().now, ttlSeconds: 60, maxEntries: 2 });
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('a', 3);
		cache.set('c', 4);
		expect(cache.get('a')).toBe(3);
		expect(cache.get('b')).toBeNull();
	});

	it('refreshes the expiry when a key is written again', () => {
		const clock = fakeClock();
		const cache = new TtlCache<number>({ now: clock.now, ttlSeconds: 60 });
		cache.set('a', 1);
		clock.advance(50);
		cache.set('a', 2);
		clock.advance(20);
		expect(cache.get('a')).toBe(2);
	});

	it('deletes and clears', () => {
		const cache = new TtlCache<number>({ now: fakeClock().now, ttlSeconds: 60 });
		cache.set('a', 1);
		cache.set('b', 2);
		cache.delete('a');
		expect(cache.get('a')).toBeNull();
		cache.clear();
		expect(cache.size()).toBe(0);
	});
});
