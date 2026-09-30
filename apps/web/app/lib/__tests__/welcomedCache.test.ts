import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	WELCOMED_STORAGE_PREFIX,
	readWelcomedCache,
	welcomedCacheKey,
	writeWelcomedCache,
} from '../welcomedCache';

/**
 * The one place the `owlat:welcomed:<userId>` entry is spelled. The first-login
 * middleware and the welcome page both go through it, and the E2E setup polls
 * for the prefix, so the key itself is part of the contract.
 */

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

describe('welcomed cache', () => {
	it('keys the entry by user id under the shared prefix', () => {
		expect(WELCOMED_STORAGE_PREFIX).toBe('owlat:welcomed:');
		expect(welcomedCacheKey('user-1')).toBe('owlat:welcomed:user-1');
	});

	it('round-trips per user', () => {
		expect(readWelcomedCache('user-1')).toBe(false);

		writeWelcomedCache('user-1');

		expect(localStorage.getItem('owlat:welcomed:user-1')).toBe('1');
		expect(readWelcomedCache('user-1')).toBe(true);
		expect(readWelcomedCache('user-2')).toBe(false);
	});

	it('ignores an entry that is not the written marker', () => {
		localStorage.setItem('owlat:welcomed:user-1', 'true');
		expect(readWelcomedCache('user-1')).toBe(false);
	});

	it('treats blocked storage as "not cached" and never throws', () => {
		vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
			throw new Error('SecurityError');
		});
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('QuotaExceededError');
		});

		expect(() => writeWelcomedCache('user-1')).not.toThrow();
		expect(readWelcomedCache('user-1')).toBe(false);
	});
});
