import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { FEATURE_FLAG_CACHE_KEY, writeCachedFeatureFlags } from '~/lib/featureFlagCache';

/**
 * Signing out forgets the last-known feature flags, so the next boot in this
 * browser starts from the shipped defaults rather than the previous session's
 * nav. A sign-out the server refused leaves them alone.
 */

const session = ref<{ data: unknown; isPending: boolean; error: unknown }>({
	data: null,
	isPending: false,
	error: null,
});
const signOutResult = ref<{ data: unknown; error: { message: string } | null }>({
	data: { success: true },
	error: null,
});

vi.mock('~/lib/auth-client', () => ({
	authClient: {
		useSession: () => session,
		signOut: vi.fn(async () => signOutResult.value),
		getSession: vi.fn(async () => ({ data: null })),
		$store: { notify: vi.fn() },
	},
}));
vi.mock('~/lib/convex-auth', () => ({ resetConvexAuthTokenCache: vi.fn() }));

const navigateTo = vi.fn();

beforeEach(() => {
	localStorage.clear();
	navigateTo.mockClear();
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('waitForLoaded', vi.fn());
	signOutResult.value = { data: { success: true }, error: null };
});

afterEach(() => {
	localStorage.clear();
});

describe('useAuth sign-out', () => {
	it('clears the cached feature flags', async () => {
		writeCachedFeatureFlags('https://convex.example', { postbox: true });
		const { useAuth } = await import('../useAuth');
		await useAuth().signOut();
		expect(localStorage.getItem(FEATURE_FLAG_CACHE_KEY)).toBeNull();
		expect(navigateTo).toHaveBeenCalledWith('/auth/login');
	});

	it('keeps them when the sign-out fails', async () => {
		writeCachedFeatureFlags('https://convex.example', { postbox: true });
		signOutResult.value = { data: null, error: { message: 'nope' } };
		const { useAuth } = await import('../useAuth');
		await expect(useAuth().signOut()).rejects.toThrow('nope');
		expect(localStorage.getItem(FEATURE_FLAG_CACHE_KEY)).not.toBeNull();
	});
});
