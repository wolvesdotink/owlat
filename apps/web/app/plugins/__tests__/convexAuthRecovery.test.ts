import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Convex client drops its auth config after a definitive failure, so a tab
 * whose session is still valid stayed anonymous until a reload (#1223). These
 * cases run the plugin against the real token fetcher (lib/convex-auth.ts) and
 * the real auth-ready state, with `fetch` stubbed and a client that follows the
 * Convex auth manager's rules: a null token from the plain and the forced fetch
 * is a failure, and so is a token the server turns away.
 */

type FetchToken = (args: { forceRefreshToken: boolean }) => Promise<string | null>;

const convex = vi.hoisted(() => ({
	installs: 0,
	serverRejects: false,
	version: 0,
}));
const auth = vi.hoisted(() => ({
	session: { data: { session: {} } as unknown, error: null as unknown },
	listeners: [] as Array<() => void>,
}));
const getSession = vi.hoisted(() => vi.fn(async () => auth.session));
const notify = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ show: vi.fn(() => 'toast-1'), remove: vi.fn() }));

vi.mock('~/lib/sharedConvexSubscriptions', () => ({ resetSharedConvexSubscriptions: vi.fn() }));
vi.mock('~/lib/featureFlagCache', () => ({ clearCachedFeatureFlags: vi.fn() }));
vi.mock('~/composables/postbox/usePostboxOfflineCache', () => ({
	wipePostboxOfflineReadCache: vi.fn(async () => undefined),
}));
vi.mock('@owlat/ui/composables/useToast', () => ({
	useToast: () => ({ showToast: toast.show, removeToast: toast.remove }),
}));
vi.mock('convex/browser', () => ({
	ConvexClient: class {
		setAuth(fetchToken: FetchToken, onChange: (isAuthenticated: boolean) => void) {
			convex.installs++;
			const version = ++convex.version;
			void (async () => {
				let token = await fetchToken({ forceRefreshToken: false });
				if (!token) token = await fetchToken({ forceRefreshToken: true });
				if (version !== convex.version) return;
				onChange(!!token && !convex.serverRejects);
			})();
		}
	},
}));
vi.mock('~/lib/auth-client', () => ({
	desktopConvexTokenRequest: () => null,
	authClient: {
		getSession,
		$store: {
			atoms: { session: { get: () => ({ data: { user: {} } }) } },
			listen: (_signal: string, listener: () => void) => {
				auth.listeners.push(listener);
			},
			notify,
		},
	},
}));
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	isDesktopRuntime: () => false,
	getActiveWorkspace: () => null,
}));
vi.mock('~/lib/runtimeLog', () => ({ logWarn }));

const navigateTo = vi.fn();
const fetchMock = vi.fn();
/** Each boot adds an `online` listener for its own client; drop them between cases. */
const windowListeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const addWindowListener = window.addEventListener.bind(window);

function tokenResponse(): Response {
	const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
	return new Response(JSON.stringify({ token: `header.${payload}.signature` }), { status: 200 });
}
const networkError = () => Promise.reject(new TypeError('Failed to fetch'));
const status = (code: number) => new Response('{}', { status: code });

/** Let the client's fetches, the session check and the handler settle. */
async function settle() {
	for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

async function bootPlugin() {
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexUrl: 'https://owlat.convex.cloud' },
	}));
	vi.stubGlobal('isPublicRoute', () => false);
	vi.stubGlobal('useRouter', () => ({ currentRoute: { value: { path: '/dashboard' } } }));
	vi.stubGlobal('navigateTo', navigateTo);
	vi.stubGlobal('fetch', fetchMock);
	vi.spyOn(window, 'addEventListener').mockImplementation(((
		type: string,
		listener: EventListenerOrEventListenerObject
	) => {
		windowListeners.push([type, listener]);
		addWindowListener(type, listener);
	}) as typeof window.addEventListener);
	vi.resetModules();
	const mod = await import('../convex.client');
	const ready = await import('~/lib/convexAuthReady');
	const nuxtApp = { $i18n: { t: (key: string) => key } };
	(mod.default as unknown as (app: unknown) => unknown)(nuxtApp);
	await settle();
	return ready;
}

describe('convex plugin: re-installs auth after a failure while the session is valid', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// No jitter: the backoff runs at exactly 1 s, 2 s, 4 s, 8 s, 16 s.
		vi.spyOn(Math, 'random').mockReturnValue(0);
		convex.installs = 0;
		convex.serverRejects = false;
		auth.session = { data: { session: {} }, error: null };
		auth.listeners = [];
		for (const mock of [
			fetchMock,
			getSession,
			notify,
			logWarn,
			navigateTo,
			toast.show,
			toast.remove,
		]) {
			mock.mockClear();
		}
		fetchMock.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const [type, listener] of windowListeners.splice(0)) {
			window.removeEventListener(type, listener);
		}
	});

	it('recovers from a token fetch that failed once, with no session signal and no reload', async () => {
		fetchMock.mockImplementationOnce(networkError).mockImplementationOnce(networkError);
		fetchMock.mockImplementation(async () => tokenResponse());
		const ready = await bootPlugin();
		expect(convex.installs).toBe(1);
		const authenticated = ready.whenConvexAuthenticated(60_000);

		await vi.advanceTimersByTimeAsync(999);
		expect(convex.installs).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await settle();

		expect(convex.installs).toBe(2);
		await expect(authenticated).resolves.toBe(true);
		// A request that never got an answer says nothing about the session.
		expect(getSession).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(navigateTo).not.toHaveBeenCalled();
		expect(toast.show).not.toHaveBeenCalled();
	});

	it('recovers when the session is valid and the server turned the token away once', async () => {
		fetchMock.mockImplementation(async () => tokenResponse());
		convex.serverRejects = true;
		const ready = await bootPlugin();
		expect(getSession).toHaveBeenCalledOnce();

		convex.serverRejects = false;
		await vi.advanceTimersByTimeAsync(1_000);
		await settle();

		expect(convex.installs).toBe(2);
		await expect(ready.whenConvexAuthSettled()).resolves.toBe(true);
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('stops after the cap when the server keeps rejecting, and warns once', async () => {
		fetchMock.mockImplementation(async () => tokenResponse());
		convex.serverRejects = true;
		await bootPlugin();

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await settle();

		// The boot install plus five re-installs (1+2+4+8+16 s), then nothing more.
		expect(convex.installs).toBe(6);
		expect(logWarn).toHaveBeenCalledOnce();
		expect(logWarn.mock.calls[0]?.[0]).toMatch(/session is still valid/);
		expect(toast.show).toHaveBeenCalledOnce();
		expect(toast.show).toHaveBeenCalledWith(
			'shared.convexAuth.lost',
			'error',
			expect.objectContaining({ durationMs: 0 })
		);
		expect(navigateTo).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it('bounds the retries for a token endpoint that stays unreachable, then resumes online', async () => {
		fetchMock.mockImplementation(async () => status(503));
		await bootPlugin();

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await settle();

		expect(convex.installs).toBe(6);
		expect(getSession).not.toHaveBeenCalled();
		expect(logWarn).toHaveBeenCalledOnce();
		expect(logWarn.mock.calls[0]?.[0]).toMatch(/could not be reached/);
		expect(toast.show).toHaveBeenCalledOnce();

		// Back online: one fresh attempt, and the notice goes once it works.
		fetchMock.mockImplementation(async () => tokenResponse());
		window.dispatchEvent(new Event('online'));
		await settle();
		expect(convex.installs).toBe(7);
		expect(toast.remove).toHaveBeenCalledWith('toast-1');
	});

	it('retries a session check that rejected on the network instead of signing out', async () => {
		fetchMock.mockImplementationOnce(async () => status(401));
		fetchMock.mockImplementationOnce(async () => status(401));
		fetchMock.mockImplementation(async () => tokenResponse());
		// better-auth rejects on a fetch or CORS failure; it does not return an error.
		getSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		const ready = await bootPlugin();
		expect(getSession).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(1_000);
		await settle();

		expect(convex.installs).toBe(2);
		await expect(ready.whenConvexAuthSettled()).resolves.toBe(true);
		expect(notify).not.toHaveBeenCalled();
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('retries a session check that answered with a server error', async () => {
		fetchMock.mockImplementationOnce(async () => status(401));
		fetchMock.mockImplementationOnce(async () => status(401));
		fetchMock.mockImplementation(async () => tokenResponse());
		auth.session = { data: null, error: { status: 503, statusText: 'Service Unavailable' } };
		const ready = await bootPlugin();

		await vi.advanceTimersByTimeAsync(1_000);
		await settle();

		expect(convex.installs).toBe(2);
		await expect(ready.whenConvexAuthSettled()).resolves.toBe(true);
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('drops a session check answered after a session signal re-authenticated', async () => {
		let answer!: (value: typeof auth.session) => void;
		getSession.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				})
		);
		fetchMock.mockImplementation(async () => tokenResponse());
		convex.serverRejects = true;
		await bootPlugin();

		convex.serverRejects = false;
		for (const listener of auth.listeners) listener();
		await settle();
		expect(convex.installs).toBe(2);

		// The old identity's check answers late: auth already works, so nothing more.
		answer({ data: { session: {} }, error: null });
		await settle();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(convex.installs).toBe(2);
	});

	it('still checks the new identity while a stale session check is in flight', async () => {
		let answer!: (value: typeof auth.session) => void;
		getSession.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				})
		);
		fetchMock.mockImplementation(async () => tokenResponse());
		convex.serverRejects = true;
		await bootPlugin();

		for (const listener of auth.listeners) listener();
		await settle();
		expect(getSession).toHaveBeenCalledTimes(2);

		answer({ data: { session: {} }, error: null });
		await settle();
		// Only the new identity's check schedules: one re-install at 1 s, not two.
		await vi.advanceTimersByTimeAsync(1_000);
		await settle();
		expect(convex.installs).toBe(3);
	});

	it('takes the sign-out path and schedules nothing when the session is gone', async () => {
		fetchMock.mockImplementation(async () => status(401));
		auth.session = { data: null, error: null };
		await bootPlugin();

		expect(navigateTo).toHaveBeenCalledWith('/auth/login');
		expect(notify).toHaveBeenCalledWith('$sessionSignal');

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(convex.installs).toBe(1);
		expect(logWarn).not.toHaveBeenCalled();
		expect(toast.show).not.toHaveBeenCalled();
	});

	it('drops a scheduled re-install when a session signal installs a new identity', async () => {
		fetchMock.mockImplementationOnce(networkError).mockImplementationOnce(networkError);
		fetchMock.mockImplementation(async () => tokenResponse());
		await bootPlugin();

		for (const listener of auth.listeners) listener();
		await settle();
		expect(convex.installs).toBe(2);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(convex.installs).toBe(2);
	});
});
