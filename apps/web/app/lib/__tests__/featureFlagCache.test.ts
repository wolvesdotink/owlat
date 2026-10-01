import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	FEATURE_FLAG_CACHE_KEY,
	FEATURE_FLAG_CACHE_MAX_SCOPES,
	clearCachedFeatureFlags,
	readCachedFeatureFlags,
	writeCachedFeatureFlags,
} from '../featureFlagCache';

/**
 * The last-known flag map seeds `useFeatureFlag` before the live subscription
 * answers. It is keyed per deployment, only ever yields booleans, never seeds a
 * live-only flag, and goes away on sign-out.
 */

const DEPLOYMENT = 'https://convex.example';
const OTHER = 'https://other.example';

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

describe('feature flag cache', () => {
	it('round-trips the flags for a deployment', () => {
		writeCachedFeatureFlags(DEPLOYMENT, { postbox: true, chat: false });
		expect(readCachedFeatureFlags(DEPLOYMENT)).toEqual({ postbox: true, chat: false });
	});

	it('keeps deployments apart', () => {
		writeCachedFeatureFlags(DEPLOYMENT, { postbox: true });
		writeCachedFeatureFlags(OTHER, { postbox: false });
		expect(readCachedFeatureFlags(DEPLOYMENT)).toEqual({ postbox: true });
		expect(readCachedFeatureFlags(OTHER)).toEqual({ postbox: false });
		expect(readCachedFeatureFlags('https://unknown.example')).toBeNull();
	});

	it('does nothing without a deployment', () => {
		writeCachedFeatureFlags(null, { postbox: true });
		expect(localStorage.getItem(FEATURE_FLAG_CACHE_KEY)).toBeNull();
		expect(readCachedFeatureFlags(null)).toBeNull();
	});

	it('never seeds a live-only flag', () => {
		writeCachedFeatureFlags(DEPLOYMENT, { 'analytics.posthog': true, postbox: true });
		expect(readCachedFeatureFlags(DEPLOYMENT)).toEqual({ postbox: true });
	});

	it('ignores corrupt storage and non-boolean values', () => {
		localStorage.setItem(FEATURE_FLAG_CACHE_KEY, '{not json');
		expect(readCachedFeatureFlags(DEPLOYMENT)).toBeNull();

		localStorage.setItem(
			FEATURE_FLAG_CACHE_KEY,
			JSON.stringify({ [DEPLOYMENT]: { flags: { postbox: 'yes', chat: true, inbox: 1 } } })
		);
		expect(readCachedFeatureFlags(DEPLOYMENT)).toEqual({ chat: true });

		localStorage.setItem(FEATURE_FLAG_CACHE_KEY, JSON.stringify([1, 2]));
		expect(readCachedFeatureFlags(DEPLOYMENT)).toBeNull();
	});

	it('skips the write when the flags did not change', () => {
		writeCachedFeatureFlags(DEPLOYMENT, { postbox: true });
		const setItem = vi.spyOn(localStorage, 'setItem');
		writeCachedFeatureFlags(DEPLOYMENT, { postbox: true });
		expect(setItem).not.toHaveBeenCalled();
		writeCachedFeatureFlags(DEPLOYMENT, { postbox: false });
		expect(setItem).toHaveBeenCalledTimes(1);
	});

	it('remembers at most a handful of deployments, dropping the oldest', () => {
		for (let i = 0; i <= FEATURE_FLAG_CACHE_MAX_SCOPES; i++) {
			writeCachedFeatureFlags(`https://d${i}.example`, { postbox: true }, 1_000 + i);
		}
		expect(readCachedFeatureFlags('https://d0.example')).toBeNull();
		expect(readCachedFeatureFlags(`https://d${FEATURE_FLAG_CACHE_MAX_SCOPES}.example`)).toEqual({
			postbox: true,
		});
		const stored = JSON.parse(localStorage.getItem(FEATURE_FLAG_CACHE_KEY) ?? '{}');
		expect(Object.keys(stored)).toHaveLength(FEATURE_FLAG_CACHE_MAX_SCOPES);
	});

	it('clears everything', () => {
		writeCachedFeatureFlags(DEPLOYMENT, { postbox: true });
		writeCachedFeatureFlags(OTHER, { chat: true });
		clearCachedFeatureFlags();
		expect(localStorage.getItem(FEATURE_FLAG_CACHE_KEY)).toBeNull();
		expect(readCachedFeatureFlags(DEPLOYMENT)).toBeNull();
	});

	it('survives storage that throws', () => {
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('QuotaExceededError');
		});
		expect(() => writeCachedFeatureFlags(DEPLOYMENT, { postbox: true })).not.toThrow();
		expect(readCachedFeatureFlags(DEPLOYMENT)).toBeNull();
	});
});
