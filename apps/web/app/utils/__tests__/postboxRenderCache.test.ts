import { describe, it, expect } from 'vitest';
import {
	createPostboxRenderCache,
	postboxRenderKey,
	type PostboxRenderEntry,
	type PostboxRenderOptions,
} from '../postboxRenderCache';

const baseOptions: PostboxRenderOptions = {
	scheme: 'light',
	showImages: false,
	loadEverything: false,
	showQuoted: false,
};

function entry(srcdoc: string, height: number | null = null): PostboxRenderEntry {
	return {
		srcdoc,
		renderScheme: 'light',
		detection: { pixelCount: 0, hosts: [] } as unknown as PostboxRenderEntry['detection'],
		height,
	};
}

describe('postboxRenderKey', () => {
	it('is stable for the same message + options', () => {
		expect(postboxRenderKey('m1', baseOptions)).toBe(postboxRenderKey('m1', baseOptions));
	});

	it('changes when any render option changes', () => {
		const base = postboxRenderKey('m1', baseOptions);
		expect(postboxRenderKey('m1', { ...baseOptions, scheme: 'dark' })).not.toBe(base);
		expect(postboxRenderKey('m1', { ...baseOptions, showImages: true })).not.toBe(base);
		expect(postboxRenderKey('m1', { ...baseOptions, loadEverything: true })).not.toBe(base);
		expect(postboxRenderKey('m1', { ...baseOptions, showQuoted: true })).not.toBe(base);
	});

	it('changes when the message id changes', () => {
		expect(postboxRenderKey('m1', baseOptions)).not.toBe(postboxRenderKey('m2', baseOptions));
	});
});

describe('createPostboxRenderCache', () => {
	it('stores and retrieves entries', () => {
		const cache = createPostboxRenderCache();
		cache.set('a', entry('A'));
		expect(cache.get('a')?.srcdoc).toBe('A');
		expect(cache.has('a')).toBe(true);
		expect(cache.get('missing')).toBeUndefined();
	});

	it('evicts the least-recently-used entry past the cap', () => {
		const cache = createPostboxRenderCache(2);
		cache.set('a', entry('A'));
		cache.set('b', entry('B'));
		cache.set('c', entry('C')); // evicts 'a'
		expect(cache.has('a')).toBe(false);
		expect(cache.has('b')).toBe(true);
		expect(cache.has('c')).toBe(true);
		expect(cache.size).toBe(2);
	});

	it('treats a get as a use (LRU touch) so it survives eviction', () => {
		const cache = createPostboxRenderCache(2);
		cache.set('a', entry('A'));
		cache.set('b', entry('B'));
		// Touch 'a' so 'b' becomes the least-recently-used.
		expect(cache.get('a')?.srcdoc).toBe('A');
		cache.set('c', entry('C')); // evicts 'b', not 'a'
		expect(cache.has('a')).toBe(true);
		expect(cache.has('b')).toBe(false);
		expect(cache.has('c')).toBe(true);
	});

	it('re-setting an existing key refreshes its LRU position without growing', () => {
		const cache = createPostboxRenderCache(2);
		cache.set('a', entry('A'));
		cache.set('b', entry('B'));
		cache.set('a', entry('A2')); // refresh 'a' → 'b' now oldest
		expect(cache.size).toBe(2);
		cache.set('c', entry('C')); // evicts 'b'
		expect(cache.has('a')).toBe(true);
		expect(cache.get('a')?.srcdoc).toBe('A2');
		expect(cache.has('b')).toBe(false);
	});

	it('update() patches an existing entry in place (e.g. the measured height)', () => {
		const cache = createPostboxRenderCache();
		cache.set('a', entry('A', null));
		cache.update('a', { height: 512 });
		const got = cache.get('a');
		expect(got?.height).toBe(512);
		expect(got?.srcdoc).toBe('A'); // other fields preserved
	});

	it('update() is a no-op on a miss', () => {
		const cache = createPostboxRenderCache();
		cache.update('missing', { height: 100 });
		expect(cache.has('missing')).toBe(false);
	});

	it('clear() empties the cache', () => {
		const cache = createPostboxRenderCache();
		cache.set('a', entry('A'));
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.has('a')).toBe(false);
	});

	it('keys built from different options address different slots', () => {
		const cache = createPostboxRenderCache();
		const light = postboxRenderKey('m1', baseOptions);
		const dark = postboxRenderKey('m1', { ...baseOptions, scheme: 'dark' });
		cache.set(light, entry('LIGHT'));
		cache.set(dark, entry('DARK'));
		expect(cache.get(light)?.srcdoc).toBe('LIGHT');
		expect(cache.get(dark)?.srcdoc).toBe('DARK');
	});
});
