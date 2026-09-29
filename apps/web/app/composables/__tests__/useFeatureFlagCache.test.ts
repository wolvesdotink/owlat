import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, type Ref } from 'vue';
import { FEATURE_FLAG_CACHE_KEY } from '~/lib/featureFlagCache';

/**
 * `useFeatureFlag` falls back to the shipped defaults until the live
 * subscription answers, and Postbox, the inbox and chat default off. The
 * fallback is now seeded from the flags this browser last saw on the same
 * deployment; the live value still wins and is written back.
 */

const DEPLOYMENT = 'https://convex.example';

let live: Ref<Record<string, boolean> | undefined>;
let loading: Ref<boolean>;
let convexUrl: string | undefined;

function seedCache(flags: Record<string, boolean>, deployment = DEPLOYMENT) {
	localStorage.setItem(
		FEATURE_FLAG_CACHE_KEY,
		JSON.stringify({ [deployment]: { flags, savedAt: 1 } })
	);
}

function cached(deployment = DEPLOYMENT): Record<string, boolean> | undefined {
	const raw = localStorage.getItem(FEATURE_FLAG_CACHE_KEY);
	return raw ? JSON.parse(raw)[deployment]?.flags : undefined;
}

async function load() {
	vi.resetModules();
	const state = new Map<string, Ref<unknown>>();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init()));
		return state.get(key);
	});
	vi.stubGlobal('useRuntimeConfig', () => ({ public: { convexUrl } }));
	vi.stubGlobal('useConvexQuery', () => ({
		data: live,
		isLoading: loading,
		error: ref(null),
	}));
	const { useFeatureFlag } = await import('../useFeatureFlag');
	return useFeatureFlag;
}

beforeEach(() => {
	live = ref(undefined);
	loading = ref(true);
	convexUrl = DEPLOYMENT;
	localStorage.clear();
});

afterEach(() => {
	localStorage.clear();
});

describe('useFeatureFlag last-known seed', () => {
	it('uses the shipped defaults when nothing is cached', async () => {
		const useFeatureFlag = await load();
		const { isEnabled } = useFeatureFlag();
		expect(isEnabled('postbox')).toBe(false);
		expect(isEnabled('chat')).toBe(false);
	});

	it('starts from the cached flags while the subscription is loading', async () => {
		seedCache({ postbox: true, chat: true, inbox: true });
		const useFeatureFlag = await load();
		const { isEnabled, isLoading } = useFeatureFlag();
		expect(isLoading.value).toBe(true);
		expect(isEnabled('postbox')).toBe(true);
		expect(isEnabled('chat')).toBe(true);
		expect(isEnabled('inbox')).toBe(true);
	});

	it('lets the live value win and writes it back', async () => {
		seedCache({ postbox: true });
		const useFeatureFlag = await load();
		const { isEnabled } = useFeatureFlag();
		expect(isEnabled('postbox')).toBe(true);

		live.value = { postbox: false, chat: true };
		loading.value = false;
		await nextTick();

		expect(isEnabled('postbox')).toBe(false);
		expect(isEnabled('chat')).toBe(true);
		expect(cached()).toEqual({ postbox: false, chat: true });
	});

	it('keeps the seed of another deployment out', async () => {
		seedCache({ postbox: true }, 'https://other.example');
		const useFeatureFlag = await load();
		expect(useFeatureFlag().isEnabled('postbox')).toBe(false);
	});

	it('never seeds PostHog from the cache', async () => {
		seedCache({ 'analytics.posthog': true, postbox: true });
		const useFeatureFlag = await load();
		const { isEnabled } = useFeatureFlag();
		expect(isEnabled('postbox')).toBe(true);
		expect(isEnabled('analytics.posthog')).toBe(false);
	});

	it('neither reads nor writes without a deployment URL', async () => {
		convexUrl = undefined;
		seedCache({ postbox: true }, '');
		const useFeatureFlag = await load();
		const { isEnabled } = useFeatureFlag();
		expect(isEnabled('postbox')).toBe(false);

		live.value = { postbox: true };
		await nextTick();
		expect(Object.keys(JSON.parse(localStorage.getItem(FEATURE_FLAG_CACHE_KEY) ?? '{}'))).toEqual([
			'',
		]);
	});
});
