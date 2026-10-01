import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A session that expires is never signed out of, so the plugin's auth-loss
 * path forgets what sign-out forgets (the cached feature flags and the
 * Postbox offline read cache) once the server confirms the session is gone,
 * and keeps them when it could not ask (offline).
 */

const auth = vi.hoisted(() => ({
	onChange: null as ((isAuthenticated: boolean) => void) | null,
	session: { data: null as unknown, error: null as unknown },
}));
const clearFlags = vi.hoisted(() => vi.fn());
const wipe = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('~/lib/sharedConvexSubscriptions', () => ({ resetSharedConvexSubscriptions: vi.fn() }));
vi.mock('~/lib/featureFlagCache', () => ({ clearCachedFeatureFlags: clearFlags }));
vi.mock('~/composables/postbox/usePostboxOfflineCache', () => ({
	wipePostboxOfflineReadCache: wipe,
}));
vi.mock('convex/browser', () => ({
	ConvexClient: class {
		setAuth(_fetchToken: unknown, onChange: (isAuthenticated: boolean) => void) {
			auth.onChange = onChange;
		}
	},
}));
vi.mock('~/lib/auth-client', () => ({
	authClient: {
		getSession: vi.fn(async () => auth.session),
		$store: {
			atoms: { session: { get: () => ({ data: { user: {} } }) } },
			listen: vi.fn(),
			notify: vi.fn(),
		},
	},
}));
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => false,
	getActiveWorkspace: () => null,
}));
vi.mock('~/lib/runtimeLog', () => ({ logWarn: vi.fn() }));

const navigateTo = vi.fn();

async function loseAuth() {
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexUrl: 'https://owlat.convex.cloud' },
	}));
	vi.stubGlobal('isPublicRoute', () => false);
	vi.stubGlobal('useRouter', () => ({ currentRoute: { value: { path: '/dashboard' } } }));
	vi.stubGlobal('navigateTo', navigateTo);
	vi.resetModules();
	const mod = await import('../convex.client');
	(mod.default as unknown as () => unknown)();
	auth.onChange!(false);
	// Let the handler settle: the session check, the lazily loaded wipe and
	// the redirect each take a turn of the event loop.
	for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('convex plugin: auth loss forgets the signed-out device state', () => {
	beforeEach(() => {
		clearFlags.mockClear();
		wipe.mockClear();
		navigateTo.mockClear();
	});

	it('wipes the offline read cache and cached flags when the session is gone', async () => {
		auth.session = { data: null, error: null };
		await loseAuth();

		expect(clearFlags).toHaveBeenCalledOnce();
		expect(wipe).toHaveBeenCalledOnce();
		expect(navigateTo).toHaveBeenCalledWith('/auth/login');
	});

	it('keeps them when the session could not be checked', async () => {
		auth.session = { data: null, error: { status: 0, message: 'Failed to fetch' } };
		await loseAuth();

		expect(clearFlags).not.toHaveBeenCalled();
		expect(wipe).not.toHaveBeenCalled();
	});

	it('keeps them when the session is still alive', async () => {
		auth.session = { data: { session: {} }, error: null };
		await loseAuth();

		expect(clearFlags).not.toHaveBeenCalled();
		expect(wipe).not.toHaveBeenCalled();
	});
});
