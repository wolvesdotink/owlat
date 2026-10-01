import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Queries stay subscribed for a while after their last reader leaves, and a
 * new reader is served their value at once (~/lib/sharedConvexSubscriptions).
 * These cases pin the one thing that makes that safe: whenever the signed-in
 * identity or organization can have changed, the plugin drops that cache
 * before the next page renders from it.
 */

const reset = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({
	listeners: [] as Array<() => void>,
	onChange: null as ((isAuthenticated: boolean) => void) | null,
}));

vi.mock('~/lib/sharedConvexSubscriptions', () => ({ resetSharedConvexSubscriptions: reset }));
vi.mock('convex/browser', () => ({
	ConvexClient: class {
		setAuth(_fetchToken: unknown, onChange: (isAuthenticated: boolean) => void) {
			auth.onChange = onChange;
		}
	},
}));
vi.mock('~/lib/auth-client', () => ({
	authClient: {
		getSession: vi.fn(async () => ({ data: { session: {} } })),
		$store: {
			listen: (_signal: string, listener: () => void) => {
				auth.listeners.push(listener);
			},
			notify: vi.fn(),
		},
	},
}));
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => false,
	getActiveWorkspace: () => null,
}));
vi.mock('~/lib/runtimeLog', () => ({ logWarn: vi.fn() }));

async function bootPlugin() {
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexUrl: 'https://owlat.convex.cloud' },
	}));
	vi.stubGlobal('isPublicRoute', () => false);
	vi.stubGlobal('useRouter', () => ({ currentRoute: { value: { path: '/dashboard' } } }));
	vi.stubGlobal('navigateTo', vi.fn());
	vi.resetModules();
	const mod = await import('../convex.client');
	(mod.default as unknown as () => unknown)();
}

describe('convex plugin: shared subscription cache and identity', () => {
	beforeEach(() => {
		reset.mockClear();
		auth.listeners = [];
		auth.onChange = null;
	});

	it('drops the cache on every session signal (sign-in, sign-out, organization switch)', async () => {
		await bootPlugin();
		expect(reset).not.toHaveBeenCalled();

		auth.listeners[0]!();
		expect(reset).toHaveBeenCalledOnce();
	});

	it('drops the cache when Convex loses authentication, not when it gains it', async () => {
		await bootPlugin();

		auth.onChange!(true);
		expect(reset).not.toHaveBeenCalled();

		auth.onChange!(false);
		expect(reset).toHaveBeenCalledOnce();
	});

	it('tells one-shot callers when auth settles, and re-arms on every session signal', async () => {
		await bootPlugin();
		const { whenConvexAuthSettled } = await import('~/lib/convexAuthReady');

		const boot = whenConvexAuthSettled();
		auth.onChange!(true);
		await expect(boot).resolves.toBe(true);

		// Sign-in, sign-out or an organization switch installs a new token: until
		// the server answers for it, callers wait again.
		auth.listeners[0]!();
		const afterSignal = vi.fn();
		void whenConvexAuthSettled().then(afterSignal);
		await Promise.resolve();
		expect(afterSignal).not.toHaveBeenCalled();

		auth.onChange!(false);
		await vi.waitFor(() => expect(afterSignal).toHaveBeenCalledWith(false));
	});
});
