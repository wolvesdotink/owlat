import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkspaceConfig, WorkspaceStoreShape } from '~/lib/desktop/workspaceTypes';
import type * as WorkspaceAccentModule from '~/lib/desktop/workspaceAccent';
import { createFakeSessionKeychain } from '~/lib/desktop/__tests__/fakeSessionKeychain';

// The desktop boot sequence as Nuxt runs it: every plugin module is imported
// first (which evaluates `auth-client.ts` and everything it pulls in), and only
// then do the plugins run in order — the async workspace boot first, then the
// Convex plugin. The auth client must follow the workspace that boot loaded,
// not whatever was known when its module was evaluated. Real auth client, real
// workspace store and storage; the Tauri bridges, the window chrome and the
// network are fakes.

const keychain = createFakeSessionKeychain();
const keychainEntries = keychain.entries;
vi.mock('@owlat/desktop/src/keychain', () => keychain.bridge);

let savedStore: WorkspaceStoreShape = { workspaces: [], activeWorkspaceId: null };
vi.mock('@owlat/desktop/src/workspace', () => ({
	loadWorkspaceStore: async () => JSON.parse(JSON.stringify(savedStore)),
	saveWorkspaceStore: async (next: WorkspaceStoreShape) => {
		savedStore = JSON.parse(JSON.stringify(next));
	},
}));

let windowLabel = 'main';
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: windowLabel }),
}));
let startupPin: string | null = null;
vi.mock('~/composables/useDesktopAppSettings', () => ({
	loadDesktopAppSettings: async () => ({ global: { startupWorkspaceId: startupPin } }),
}));
vi.mock('@owlat/desktop/src/window', () => ({
	watchFullscreen: vi.fn(async () => {}),
	setAccentFrameVisible: vi.fn(async () => {}),
	windowReady: vi.fn(async () => {}),
}));
vi.mock('~/lib/desktop/deepLink.client', () => ({ setupDeepLinks: vi.fn(async () => {}) }));
vi.mock('~/lib/desktop/updater.client', () => ({ setupUpdateChecks: vi.fn() }));
vi.mock('~/lib/desktop/nativeFeel.client', () => ({ installNativeFeel: vi.fn() }));
vi.mock('~/lib/desktop/workspaceAccent', async (importOriginal) => ({
	...(await importOriginal<typeof WorkspaceAccentModule>()),
	applyWorkspaceAccent: vi.fn(),
}));
vi.mock('~/lib/desktop/splashPaint', () => ({ afterSplashPaint: () => new Promise(() => {}) }));

const convexClients: Array<{
	url: string;
	fetchToken: ((args: { forceRefreshToken: boolean }) => Promise<string | null>) | null;
}> = [];
vi.mock('convex/browser', () => ({
	ConvexClient: class {
		entry: (typeof convexClients)[number];
		constructor(url: string) {
			this.entry = { url, fetchToken: null };
			convexClients.push(this.entry);
		}
		setAuth(fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>) {
			this.entry.fetchToken = fetchToken;
		}
	},
}));

function workspace(id: string): WorkspaceConfig {
	return {
		id,
		label: id,
		siteUrl: `https://${id}.example.com`,
		convexUrl: `https://${id}.example.com/convex`,
		convexSiteUrl: `https://site.${id}.example.com`,
		userId: `user-${id}`,
		tokenRef: `owlat-ws:${id}`,
		addedAt: 1,
		lastActiveAt: 1,
		accentColor: '#8c5a7a',
	};
}

function sessionBlob(token: string): string {
	return JSON.stringify({
		'better-auth_cookie': JSON.stringify({
			'better-auth.session_token': { value: token, expires: null },
		}),
	});
}

const requests: Array<{ url: string; cookie: string }> = [];
const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const headers = new Headers(init?.headers ?? {});
	requests.push({ url, cookie: headers.get('Better-Auth-Cookie') ?? '' });
	return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
});

type Plugin = { setup?: (nuxtApp: unknown) => unknown } | ((nuxtApp: unknown) => unknown);
const run = (plugin: Plugin, nuxtApp: unknown) =>
	typeof plugin === 'function' ? plugin(nuxtApp) : plugin.setup?.(nuxtApp);

/**
 * One page load. Imports every plugin module before running any of them (what
 * Nuxt's generated plugin list does), then runs them in their order.
 */
async function bootPage() {
	vi.resetModules();
	const [warmup, desktop, convex, authClientModule] = await Promise.all([
		import('../0.auth-warmup.client'),
		import('../0.desktop-workspace.client'),
		import('../convex.client'),
		import('~/lib/auth-client'),
	]);
	const nuxtApp = { $router: { push: vi.fn() }, hook: vi.fn() };
	await run(desktop.default as unknown as Plugin, nuxtApp);
	await run(warmup.default as unknown as Plugin, nuxtApp);
	const provided = (await run(convex.default as unknown as Plugin, nuxtApp)) as {
		provide: { convex: unknown };
	};
	return { ...authClientModule, convex: provided.provide.convex };
}

beforeEach(() => {
	(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
	keychain.reset();
	savedStore = { workspaces: [], activeWorkspaceId: null };
	requests.length = 0;
	convexClients.length = 0;
	windowLabel = 'main';
	startupPin = null;
	sessionStorage.clear();
	vi.stubGlobal('fetch', fakeFetch);
	vi.stubGlobal('useRuntimeConfig', () => ({
		public: { convexUrl: 'https://web.example.com/convex', setupMode: false },
	}));
	vi.stubGlobal('isPublicRoute', () => false);
	vi.stubGlobal('useRoute', () => ({ path: '/dashboard' }));
	vi.stubGlobal('useRouter', () => ({ currentRoute: { value: { path: '/dashboard' } } }));
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('addRouteMiddleware', vi.fn());
});

afterEach(() => {
	delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

describe('desktop boot: the auth client follows the hydrated workspace', () => {
	it('sends the first auth request of a cold start to the persisted remote workspace', async () => {
		savedStore = { workspaces: [workspace('remote')], activeWorkspaceId: 'remote' };
		keychainEntries.set('owlat-ws:remote', sessionBlob('remote-session'));

		const page = await bootPage();
		await page.authClient.getSession();

		expect(requests[0]?.url).toMatch(
			/^https:\/\/site\.remote\.example\.com\/api\/auth\/get-session/
		);
		expect(requests[0]?.cookie).toContain('remote-session');
		expect(requests.some((r) => r.url.includes('localhost'))).toBe(false);
	});

	it("fetches the Convex token from that workspace with that workspace's session", async () => {
		savedStore = { workspaces: [workspace('remote')], activeWorkspaceId: 'remote' };
		keychainEntries.set('owlat-ws:remote', sessionBlob('remote-session'));

		await bootPage();
		expect(convexClients).toHaveLength(1);
		expect(convexClients[0]?.url).toBe('https://remote.example.com/convex');
		await convexClients[0]?.fetchToken?.({ forceRefreshToken: true });

		const tokenRequest = requests.find((r) => r.url.includes('/api/auth/convex/token'));
		expect(tokenRequest?.url).toBe('https://site.remote.example.com/api/auth/convex/token');
		expect(tokenRequest?.cookie).toContain('remote-session');
	});

	it('applies the startup pin on a cold start of the main window', async () => {
		savedStore = {
			workspaces: [workspace('last'), workspace('pinned')],
			activeWorkspaceId: 'last',
		};
		keychainEntries.set('owlat-ws:pinned', sessionBlob('pinned-session'));
		startupPin = 'pinned';

		const page = await bootPage();
		await page.getSession();

		expect(requests[0]?.url).toMatch(/^https:\/\/site\.pinned\.example\.com\//);
		expect(requests[0]?.cookie).toContain('pinned-session');
	});

	it('boots a compose window into the active workspace, not the startup pin', async () => {
		savedStore = {
			workspaces: [workspace('active'), workspace('pinned')],
			activeWorkspaceId: 'active',
		};
		keychainEntries.set('owlat-ws:active', sessionBlob('active-session'));
		startupPin = 'pinned';
		windowLabel = 'compose';

		const page = await bootPage();
		await page.authClient.getSession();

		expect(requests[0]?.url).toMatch(/^https:\/\/site\.active\.example\.com\//);
		expect(requests[0]?.cookie).toContain('active-session');
	});

	it('targets the new workspace, with its session, after a switch reload', async () => {
		savedStore = { workspaces: [workspace('a'), workspace('b')], activeWorkspaceId: 'a' };
		keychainEntries.set('owlat-ws:a', sessionBlob('a-session'));
		keychainEntries.set('owlat-ws:b', sessionBlob('b-session'));

		await bootPage();
		const { useDesktopWorkspaces } = await import('~/composables/useDesktopWorkspaces');
		Object.defineProperty(window.location, 'assign', {
			value: vi.fn(),
			configurable: true,
			writable: true,
		});
		await useDesktopWorkspaces().switchTo('b');
		expect(savedStore.activeWorkspaceId).toBe('b');

		// The switch reloads the webview: a new page load boots again.
		requests.length = 0;
		const reloaded = await bootPage();
		await reloaded.authClient.getSession();

		expect(requests[0]?.url).toMatch(/^https:\/\/site\.b\.example\.com\//);
		expect(requests[0]?.cookie).toContain('b-session');
		expect(requests[0]?.cookie).not.toContain('a-session');
	});

	it('sends nothing anywhere when no workspace is connected', async () => {
		const page = await bootPage();
		const session = await page.authClient.getSession();
		await page.listOrganizations();

		expect(session.data).toBeNull();
		expect(page.convex).toBeNull();
		expect(requests).toEqual([]);
	});
});

describe('web boot: the auth client is the same-origin one', () => {
	beforeEach(() => {
		delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
	});

	it('asks this origin for the session', async () => {
		const page = await bootPage();
		await page.authClient.getSession();

		expect(requests.map((r) => r.url)).toContain(`${window.location.origin}/api/auth/get-session`);
		expect(requests.every((r) => !r.url.includes('example.com/api/auth'))).toBe(true);
		expect(convexClients[0]?.url).toBe('https://web.example.com/convex');
	});
});
