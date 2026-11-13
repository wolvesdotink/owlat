import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The route warm-up plugin must START, during its own setup, every download the
 * first navigation will wait for: the route's components, its layout, its
 * named middleware and its area catalog. The session check is the reason this
 * matters: middleware awaits it, so anything that starts after it queues
 * behind a round trip. The real auth warm-up runs next to it against a stubbed
 * `fetch` whose session answer the test releases, so the assertions are an
 * order of events.
 */

type Plugin = { enforce?: string; parallel?: boolean; setup: () => void };

const events: string[] = [];

const build = vi.hoisted(() => ({
	layouts: {} as Record<string, { __asyncLoader?: () => Promise<unknown> }>,
	namedMiddleware: {} as Record<string, () => Promise<unknown>>,
	areaRoutes: [] as Array<{ path: string; exact: boolean; area: string }>,
	areaChunks: {} as Record<string, Record<string, () => Promise<{ default: object }>>>,
}));
vi.mock('#build/layouts', () => ({
	get default() {
		return build.layouts;
	},
}));
vi.mock('#build/middleware', () => ({
	get namedMiddleware() {
		return build.namedMiddleware;
	},
	globalMiddleware: [],
}));
vi.mock('#build/owlat-i18n-areas.mjs', () => ({
	get areaRoutes() {
		return build.areaRoutes;
	},
	get areaChunks() {
		return build.areaChunks;
	},
	messageRoots: ['dashboard'],
}));

interface FakeRoute {
	path: string;
	fullPath: string;
	meta: Record<string, unknown>;
	matched: Array<{ meta: Record<string, unknown> }>;
}

let route: FakeRoute;
let publicConfig: Record<string, unknown>;
let releaseSession: () => void = () => {};
/** Resolves once the auth warm-up has sent the session request. */
let sessionRequested: Promise<void>;
let markSessionRequested: () => void = () => {};

const loader = (name: string) => () => {
	events.push(name);
	return Promise.resolve({ default: {} });
};

function requestUrl(input: unknown): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.toString();
	return (input as Request).url;
}

/** Globals set for one case and restored after it (the setup file's auto-import stubs stay). */
const restores: Array<() => void> = [];
function stub(name: string, value: unknown) {
	const target = globalThis as Record<string, unknown>;
	const had = name in target;
	const previous = target[name];
	target[name] = value;
	restores.push(() => {
		if (had) target[name] = previous;
		else delete target[name];
	});
}

async function loadPlugins() {
	vi.resetModules();
	stub('waitForLoaded', (await import('~/utils/waitForLoaded')).waitForLoaded);
	const auth = (await import('../0.auth-warmup.client')).default as unknown as Plugin;
	const warmup = (await import('../0.route-warmup.client')).default as unknown as Plugin;
	const { useAuth } = await import('~/composables/useAuth');
	return { auth, warmup, useAuth };
}

function dashboardRoute(path: string): FakeRoute {
	const meta = { layout: 'dashboard', middleware: ['auth', () => true] };
	return { path, fullPath: path, meta, matched: [{ meta: {} }, { meta }] };
}

describe('route warm-up plugin', () => {
	beforeEach(() => {
		events.length = 0;
		route = dashboardRoute('/dashboard/postbox/inbox');
		publicConfig = { convexUrl: '', setupMode: false };
		build.layouts = {
			dashboard: { __asyncLoader: loader('layout:dashboard') },
			admin: { __asyncLoader: loader('layout:admin') },
		};
		build.namedMiddleware = { auth: loader('middleware:auth'), admin: loader('middleware:admin') };
		build.areaRoutes = [
			{ path: '/dashboard/postbox', exact: false, area: 'dashboard-postbox' },
			{ path: '/dashboard/admin', exact: false, area: 'dashboard-admin' },
		];
		build.areaChunks = {
			'dashboard-postbox': {
				en: loader('area:dashboard-postbox:en'),
				de: loader('area:dashboard-postbox:de'),
			},
			'dashboard-admin': { en: loader('area:dashboard-admin:en') },
		};
		document.cookie = 'owlat-locale=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
		sessionRequested = new Promise((resolve) => (markSessionRequested = resolve));

		stub(
			'fetch',
			vi.fn((input: unknown) => {
				const url = requestUrl(input);
				if (!url.includes('/get-session')) {
					return Promise.reject(new Error(`unexpected request ${url}`));
				}
				events.push('session:requested');
				markSessionRequested();
				return new Promise<Response>((resolve) => {
					releaseSession = () => {
						events.push('session:answered');
						resolve(
							new Response('null', {
								status: 200,
								headers: { 'content-type': 'application/json' },
							})
						);
					};
				});
			})
		);
		stub('useRoute', () => route);
		stub('useRouter', () => ({ currentRoute: { value: route } }));
		stub('useRuntimeConfig', () => ({ public: publicConfig }));
		stub(
			'preloadRouteComponents',
			vi.fn((path: string) => {
				events.push(`route:${path}`);
				return Promise.resolve();
			})
		);
	});

	afterEach(() => {
		while (restores.length) restores.pop()?.();
	});

	it('runs first and does not hold up the plugins after it', async () => {
		const { warmup } = await loadPlugins();
		expect(warmup.enforce).toBe('pre');
		expect(warmup.parallel).toBe(true);
	});

	it('starts the route, its layout, its middleware and its area catalog before the session answers', async () => {
		const { auth, warmup, useAuth } = await loadPlugins();

		auth.setup();
		warmup.setup();
		events.push('setup returned');

		await sessionRequested;
		releaseSession();
		await useAuth().waitUntilReady();

		const started = events.slice(0, events.indexOf('setup returned'));
		expect(started).toEqual(
			expect.arrayContaining([
				'route:/dashboard/postbox/inbox',
				'layout:dashboard',
				'middleware:auth',
				'area:dashboard-postbox:en',
			])
		);
		expect(events.indexOf('session:answered')).toBeGreaterThan(events.indexOf('setup returned'));
		// Only what this route needs.
		expect(events).not.toContain('layout:admin');
		expect(events).not.toContain('middleware:admin');
		expect(events).not.toContain('area:dashboard-admin:en');
		expect(events).not.toContain('area:dashboard-postbox:de');
	});

	it('asks for the area catalog in the locale the picker saved', async () => {
		document.cookie = 'owlat-locale=de; path=/';
		const { warmup } = await loadPlugins();

		warmup.setup();
		expect(events).toContain('area:dashboard-postbox:de');
		expect(events).not.toContain('area:dashboard-postbox:en');
	});

	it('starts no layout for a page without one and no catalog outside every area', async () => {
		route = {
			path: '/dashboard/welcome-tour',
			fullPath: '/dashboard/welcome-tour',
			meta: { layout: false, middleware: 'auth' },
			matched: [{ meta: { layout: false, middleware: 'auth' } }],
		};
		const { warmup } = await loadPlugins();

		warmup.setup();
		expect(events).toEqual(['route:/dashboard/welcome-tour', 'middleware:auth']);
	});

	it('skips public routes, like the auth warm-up does', async () => {
		route = dashboardRoute('/share');
		const { warmup } = await loadPlugins();

		warmup.setup();
		expect(events).toEqual([]);
	});

	it('skips setup mode', async () => {
		publicConfig = { ...publicConfig, setupMode: true };
		const { warmup } = await loadPlugins();

		warmup.setup();
		expect(events).toEqual([]);
	});

	it('does nothing on the desktop runtime, whose boot plugin may switch the workspace first', async () => {
		stub('__TAURI_INTERNALS__', {});
		const { warmup } = await loadPlugins();

		warmup.setup();
		expect(events).toEqual([]);
	});
});
