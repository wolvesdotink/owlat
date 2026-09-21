// @vitest-environment happy-dom
/**
 * The offline app shell service worker (apps/web/service-worker/sw.js).
 *
 * The file ships as a plain classic script — no bundler, no imports — so this
 * suite loads THE EXACT BYTES that are served and runs them against a fake
 * `self` (CacheStorage, fetch, clients). Nothing is re-implemented here: the
 * worker exposes its internals on `self.__owlatShell` for precisely this.
 *
 * What is pinned: the routing table (what is cached and, more importantly,
 * what is never touched), network-first navigations with an offline shell
 * fallback, cache-first hashed assets, and the build-id cache versioning that
 * makes a deploy replace the old cache instead of accreting beside it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workerSource = readFileSync(
	resolve(here, '..', '..', '..', 'service-worker', 'sw.js'),
	'utf8'
);

const ORIGIN = 'https://mail.example.com';
const BUILD_ID = 'build-one';

type Body = { status?: number; type?: string; body?: string; redirected?: boolean };

function makeResponse({ status = 200, type = 'text/html', body = 'ok', redirected }: Body) {
	const response = new Response(body, { status, headers: { 'content-type': type } });
	if (redirected) Object.defineProperty(response, 'redirected', { value: true });
	return response;
}

/** Key a cache entry by pathname — the fake's stand-in for request matching. */
function keyOf(request: unknown): string {
	const url = typeof request === 'string' ? request : (request as { url: string }).url;
	return url.startsWith('http') ? new URL(url).pathname : url;
}

/** In-memory CacheStorage. Insertion order matters: it is "build order". */
function fakeCaches() {
	const store = new Map<string, Map<string, Response>>();
	const api = {
		async open(name: string) {
			let entries = store.get(name);
			if (!entries) {
				entries = new Map();
				store.set(name, entries);
			}
			const cache = entries;
			return {
				async match(request: unknown) {
					return cache.get(keyOf(request));
				},
				async put(request: unknown, response: Response) {
					cache.set(keyOf(request), response);
				},
				async add(url: string) {
					const response = await fetchMock(url);
					if (!response.ok) throw new Error(`add failed: ${url}`);
					cache.set(keyOf(url), response);
				},
			};
		},
		async keys() {
			return [...store.keys()];
		},
		async delete(name: string) {
			return store.delete(name);
		},
	};
	return { api, store };
}

/** Routes every fetch the worker makes; per-test overrides live in `routes`. */
let routes: Record<string, () => Promise<Response>>;
let fetchMock: ReturnType<typeof vi.fn>;

function makeSelf(caches: ReturnType<typeof fakeCaches>) {
	const listeners = new Map<string, (event: unknown) => void>();
	const self = {
		location: { origin: ORIGIN },
		caches: caches.api,
		// Late-bound: the mock is rebuilt per test, the worker is loaded once.
		fetch: (input: unknown, init?: unknown) => fetchMock(input, init),
		clients: { claim: vi.fn(async () => {}) },
		skipWaiting: vi.fn(async () => {}),
		addEventListener: (type: string, handler: (event: unknown) => void) => {
			listeners.set(type, handler);
		},
	} as Record<string, unknown>;
	new Function('self', workerSource)(self);
	return { self, listeners, shell: self.__owlatShell as unknown as Shell };
}

interface Shell {
	CACHE_PREFIX: string;
	SHELL_URL: string;
	PRECACHE_URLS: string[];
	cacheNameFor(id: string): string;
	staleCacheNames(names: string[], current: string): string[];
	classifyRequest(input: {
		method: string;
		mode?: string;
		url: string;
		origin: string;
	}): 'navigate' | 'asset' | 'bypass';
	resolveCacheName(): Promise<string>;
	handleNavigate(request: unknown): Promise<Response>;
	handleAsset(request: unknown): Promise<Response>;
	precache(): Promise<void>;
	resetCacheName(): void;
}

const navigation = (path = '/dashboard/postbox/inbox') => ({
	method: 'GET',
	mode: 'navigate',
	url: `${ORIGIN}${path}`,
});
const asset = (path: string) => ({ method: 'GET', mode: 'cors', url: `${ORIGIN}${path}` });

beforeEach(() => {
	routes = {
		'/_nuxt/builds/latest.json': async () =>
			new Response(JSON.stringify({ id: BUILD_ID }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			}),
		'/': async () => makeResponse({ body: '<html>shell</html>' }),
		'/manifest.webmanifest': async () =>
			makeResponse({ type: 'application/manifest+json', body: '{}' }),
		'/favicon.svg': async () => makeResponse({ type: 'image/svg+xml', body: '<svg/>' }),
	};
	fetchMock = vi.fn(async (input: unknown) => {
		const route = routes[keyOf(input)];
		if (!route) throw new TypeError(`no route for ${keyOf(input)}`);
		return route();
	});
});

describe('service worker routing table', () => {
	const { shell } = makeSelf(fakeCaches());

	it.each([
		['a navigation', navigation(), 'navigate'],
		['a hashed build asset', asset('/_nuxt/entry.abc123.js'), 'asset'],
		['a bundled font', asset('/_fonts/figtree.woff2'), 'asset'],
		['the web manifest', asset('/manifest.webmanifest'), 'asset'],
	])('caches %s', (_case, request, expected) => {
		expect(shell.classifyRequest({ ...request, origin: ORIGIN })).toBe(expected);
	});

	it.each([
		// Cookie-bearing auth proxy + instance control plane: never cached.
		['the API', asset('/api/auth/session')],
		// Read live or the version check would answer out of its own cache.
		['the build manifest', asset('/_nuxt/builds/latest.json')],
		// Convex, PostHog, iconify — all cross-origin.
		['cross-origin traffic', { method: 'GET', mode: 'cors', url: 'https://convex.example/api' }],
		// A mutation is never a cache read.
		['a POST', { method: 'POST', mode: 'cors', url: `${ORIGIN}/_nuxt/entry.js` }],
		// An app route fetched as data, not navigated to.
		['an unknown same-origin path', asset('/dashboard/postbox/inbox')],
	])('never touches %s', (_case, request) => {
		expect(shell.classifyRequest({ ...request, origin: ORIGIN })).toBe('bypass');
	});

	it('bypasses a request whose URL cannot be parsed', () => {
		expect(shell.classifyRequest({ method: 'GET', url: 'not a url', origin: ORIGIN })).toBe(
			'bypass'
		);
	});
});

describe('cache versioning', () => {
	it('names the cache after the running build and calls every other one stale', () => {
		const { shell } = makeSelf(fakeCaches());
		const current = shell.cacheNameFor(BUILD_ID);
		expect(current).toBe(`owlat-shell-${BUILD_ID}`);
		expect(
			shell.staleCacheNames([current, 'owlat-shell-older', 'unrelated-cache'], current)
		).toEqual(['owlat-shell-older']);
	});

	it('deletes the previous build’s cache once the new build id resolves', async () => {
		const caches = fakeCaches();
		caches.store.set('owlat-shell-older', new Map());
		const { shell } = makeSelf(caches);

		expect(await shell.resolveCacheName()).toBe(`owlat-shell-${BUILD_ID}`);
		expect([...caches.store.keys()]).not.toContain('owlat-shell-older');
	});

	it('reuses the newest existing cache when the build id cannot be read (offline)', async () => {
		const caches = fakeCaches();
		caches.store.set('owlat-shell-older', new Map());
		caches.store.set('owlat-shell-newer', new Map());
		const { shell } = makeSelf(caches);
		routes['/_nuxt/builds/latest.json'] = async () => {
			throw new TypeError('offline');
		};

		// A cold offline start must serve shell AND assets from one coherent
		// build, so it picks the last cache written rather than an empty one.
		expect(await shell.resolveCacheName()).toBe('owlat-shell-newer');
		expect([...caches.store.keys()]).toContain('owlat-shell-older');
	});
});

describe('install', () => {
	it('precaches the shell so the very first offline start has something to paint', async () => {
		const caches = fakeCaches();
		const { shell } = makeSelf(caches);

		await shell.precache();

		const cache = caches.store.get(`owlat-shell-${BUILD_ID}`);
		expect([...(cache?.keys() ?? [])].sort()).toEqual([...shell.PRECACHE_URLS].sort());
	});

	it('installs anyway when one precache URL is missing', async () => {
		const caches = fakeCaches();
		const { shell } = makeSelf(caches);
		routes['/favicon.svg'] = async () => makeResponse({ status: 404 });

		await expect(shell.precache()).resolves.toBeUndefined();
		const cache = caches.store.get(`owlat-shell-${BUILD_ID}`);
		expect([...(cache?.keys() ?? [])].sort()).toEqual(['/', '/manifest.webmanifest']);
	});
});

describe('navigations', () => {
	it('is network-first: an online visitor never gets a stale document', async () => {
		const caches = fakeCaches();
		const { shell } = makeSelf(caches);
		const cache = await caches.api.open(`owlat-shell-${BUILD_ID}`);
		await cache.put('/', makeResponse({ body: '<html>OLD</html>' }));
		routes['/dashboard/postbox/inbox'] = async () => makeResponse({ body: '<html>NEW</html>' });

		const response = await shell.handleNavigate(navigation());

		expect(await response.text()).toContain('NEW');
		// …and the fresh document replaces the cached shell for the next outage.
		const stored = caches.store.get(`owlat-shell-${BUILD_ID}`)?.get('/');
		expect(await stored?.text()).toContain('NEW');
	});

	it('serves the cached shell when the network is gone', async () => {
		const caches = fakeCaches();
		const { shell } = makeSelf(caches);
		const cache = await caches.api.open('owlat-shell-previous');
		await cache.put('/', makeResponse({ body: '<html>shell</html>' }));
		routes['/_nuxt/builds/latest.json'] = async () => {
			throw new TypeError('offline');
		};

		const response = await shell.handleNavigate(navigation('/dashboard/postbox/inbox'));

		// This is the whole point of idea 49: a cold offline start paints the app.
		expect(await response.text()).toContain('shell');
	});

	it('fails like today when there is nothing cached to fall back to', async () => {
		const { shell } = makeSelf(fakeCaches());
		routes['/dashboard/postbox/inbox'] = async () => {
			throw new TypeError('offline');
		};

		await expect(shell.handleNavigate(navigation())).rejects.toThrow();
	});

	it('does not cache a non-HTML or redirected navigation response', async () => {
		const caches = fakeCaches();
		const { shell } = makeSelf(caches);
		routes['/dashboard/mail'] = async () =>
			makeResponse({ body: '<html>redirected</html>', redirected: true });

		const response = await shell.handleNavigate(navigation('/dashboard/mail'));

		// A response with the redirected flag cannot be returned to a navigation,
		// so it is handed back stripped — and never becomes the shell.
		expect(response.redirected).toBe(false);
		expect(await response.text()).toContain('redirected');
		expect(caches.store.get(`owlat-shell-${BUILD_ID}`)?.has('/')).toBeFalsy();
	});
});

describe('assets', () => {
	it('is cache-first for content-hashed build output', async () => {
		const caches = fakeCaches();
		const { shell } = makeSelf(caches);
		routes['/_nuxt/entry.abc.js'] = async () =>
			makeResponse({ type: 'text/javascript', body: 'console.log(1)' });

		const first = await shell.handleAsset(asset('/_nuxt/entry.abc.js'));
		expect(await first.text()).toContain('console.log');
		const fetchesAfterFirst = fetchMock.mock.calls.length;

		const second = await shell.handleAsset(asset('/_nuxt/entry.abc.js'));
		expect(await second.text()).toContain('console.log');
		// The second read never reaches the network — that is the cold-start win.
		expect(fetchMock.mock.calls.length).toBe(fetchesAfterFirst);
	});

	it('does not cache a failed asset response', async () => {
		const caches = fakeCaches();
		const { shell } = makeSelf(caches);
		routes['/_nuxt/gone.js'] = async () => makeResponse({ status: 404, body: '' });

		await shell.handleAsset(asset('/_nuxt/gone.js'));
		expect(caches.store.get(`owlat-shell-${BUILD_ID}`)?.has('/_nuxt/gone.js')).toBeFalsy();
	});
});

describe('fetch event wiring', () => {
	it('leaves bypassed requests entirely alone (no respondWith)', () => {
		const { listeners } = makeSelf(fakeCaches());
		const respondWith = vi.fn();
		listeners.get('fetch')?.({ request: asset('/api/auth/session'), respondWith });
		expect(respondWith).not.toHaveBeenCalled();
	});

	it('answers navigations and assets', async () => {
		const { listeners } = makeSelf(fakeCaches());
		const responded: Promise<Response>[] = [];
		const respondWith = (value: Promise<Response>) => responded.push(value);

		listeners.get('fetch')?.({ request: navigation('/'), respondWith });
		expect(responded).toHaveLength(1);
		await expect(responded[0]).resolves.toBeDefined();
	});

	it('claims open pages on activate so the first load is controlled', async () => {
		const { self, listeners } = makeSelf(fakeCaches());
		let work: Promise<unknown> = Promise.resolve();
		listeners.get('activate')?.({ waitUntil: (value: Promise<unknown>) => (work = value) });
		await work;
		expect((self.clients as { claim: ReturnType<typeof vi.fn> }).claim).toHaveBeenCalled();
	});
});
