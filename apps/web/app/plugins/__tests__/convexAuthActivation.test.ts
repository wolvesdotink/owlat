import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * When the Convex client gets its auth. A visit that only opens a public page
 * (/terms, a share link) must not ask for a session or a token; a visit that
 * starts there and then enters the app must get an authenticated client without
 * a reload. Plugins run once, so the plugin cannot decide this at boot alone.
 */

const convex = vi.hoisted(() => ({
	constructed: 0,
	setAuth: [] as Array<{
		fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
		onChange: (isAuthenticated: boolean) => void;
	}>,
}));
const auth = vi.hoisted(() => ({
	listeners: [] as Array<() => void>,
	getSession: vi.fn(async () => ({ data: { session: {} }, error: null })),
}));
const getConvexAuthToken = vi.hoisted(() => vi.fn(async () => 'jwt'));

vi.mock('convex/browser', () => ({
	ConvexClient: class {
		constructor() {
			convex.constructed++;
		}
		setAuth(
			fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>,
			onChange: (isAuthenticated: boolean) => void
		) {
			convex.setAuth.push({ fetchToken, onChange });
		}
	},
}));
vi.mock('~/lib/auth-client', () => ({
	authClient: {
		getSession: auth.getSession,
		$store: {
			listen: (_signal: string, listener: () => void) => {
				auth.listeners.push(listener);
			},
			notify: vi.fn(),
		},
	},
}));
vi.mock('~/lib/convex-auth', () => ({
	getConvexAuthToken,
	lastConvexTokenFailure: () => null,
	resetConvexAuthTokenCache: vi.fn(),
}));
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => false,
	getActiveWorkspace: () => null,
}));
vi.mock('~/lib/runtimeLog', () => ({ logWarn: vi.fn() }));
vi.mock('~/lib/sharedConvexSubscriptions', () => ({ resetSharedConvexSubscriptions: vi.fn() }));

type RouteMiddleware = (to: { path: string }) => unknown;
let middleware: RouteMiddleware[] = [];

/** Boot the plugin on `path`, and return a navigator that runs the global middleware. */
async function bootOn(path: string) {
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexUrl: 'https://owlat.convex.cloud' },
	}));
	vi.stubGlobal('useRoute', () => ({ path }));
	vi.stubGlobal('isPublicRoute', () => ['/terms', '/imprint', '/share', '/archive'].includes(path));
	vi.stubGlobal('useRouter', () => ({ currentRoute: { value: { path } } }));
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal(
		'addRouteMiddleware',
		(_name: string, fn: RouteMiddleware, options: { global?: boolean }) => {
			if (options?.global) middleware.push(fn);
		}
	);
	vi.resetModules();
	const mod = await import('../convex.client');
	(mod.default as unknown as () => unknown)();
	const readiness = await import('~/lib/convexAuthReady');
	return {
		navigate: (to: string) => {
			for (const fn of middleware) fn({ path: to });
		},
		...readiness,
	};
}

describe('convex plugin: auth activation', () => {
	beforeEach(() => {
		convex.constructed = 0;
		convex.setAuth = [];
		auth.listeners = [];
		auth.getSession.mockClear();
		getConvexAuthToken.mockClear();
		middleware = [];
	});

	it('installs auth at boot on an app route', async () => {
		await bootOn('/dashboard');

		expect(convex.setAuth).toHaveLength(1);
		expect(auth.listeners).toHaveLength(1);
		expect(middleware).toHaveLength(0);
	});

	it('asks for nothing while a visit stays on public pages', async () => {
		const page = await bootOn('/terms');
		page.navigate('/imprint');
		page.navigate('/terms');

		expect(convex.constructed).toBe(1);
		expect(convex.setAuth).toHaveLength(0);
		expect(auth.listeners).toHaveLength(0);
		expect(getConvexAuthToken).not.toHaveBeenCalled();
		expect(auth.getSession).not.toHaveBeenCalled();
	});

	it('installs auth on the first navigation from a public page into the app', async () => {
		const page = await bootOn('/terms');

		page.navigate('/auth/login');

		expect(convex.setAuth).toHaveLength(1);
		expect(auth.listeners).toHaveLength(1);
		await convex.setAuth[0]!.fetchToken({ forceRefreshToken: false });
		expect(getConvexAuthToken).toHaveBeenCalledOnce();
	});

	it('installs it once, on the same client, however often the visit crosses over', async () => {
		const page = await bootOn('/imprint');

		page.navigate('/dashboard');
		page.navigate('/terms');
		page.navigate('/dashboard');
		page.navigate('/imprint');
		page.navigate('/dashboard/postbox');

		expect(convex.constructed).toBe(1);
		expect(convex.setAuth).toHaveLength(1);
		expect(auth.listeners).toHaveLength(1);
	});

	it('reports readiness on the late path just as at boot', async () => {
		const page = await bootOn('/terms');
		page.navigate('/dashboard');

		const settled = page.whenConvexAuthSettled();
		convex.setAuth[0]!.onChange(true);
		await expect(settled).resolves.toBe(true);
	});

	// The sign-in that follows /terms → /auth/login fires the session signal;
	// the listener installed on the late path must re-install the token fetcher
	// for the new session, as the boot path does.
	it('re-authenticates on a sign-in made after the late activation', async () => {
		const page = await bootOn('/terms');
		page.navigate('/auth/login');

		auth.listeners[0]!();

		expect(convex.setAuth).toHaveLength(2);
		const pending = vi.fn();
		void page.whenConvexAuthSettled().then(pending);
		await Promise.resolve();
		expect(pending).not.toHaveBeenCalled();
		convex.setAuth[1]!.onChange(true);
		await vi.waitFor(() => expect(pending).toHaveBeenCalledWith(true));
	});

	it('keeps the auth-loss handling on the late path', async () => {
		const page = await bootOn('/terms');
		page.navigate('/dashboard');

		convex.setAuth[0]!.onChange(false);

		await vi.waitFor(() => expect(auth.getSession).toHaveBeenCalledOnce());
		await expect(page.whenConvexAuthSettled()).resolves.toBe(false);
	});
});
