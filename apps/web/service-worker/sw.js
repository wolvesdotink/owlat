/**
 * Owlat offline app shell — service worker (plan idea 49).
 *
 * WHY THIS EXISTS. The app is `ssr: false` and ships a web manifest, so it
 * installs like a PWA — but without a service worker a cold start with no
 * connection is a blank window, and the 500-row/200-body IndexedDB offline
 * cache behind it is unreachable. This worker precaches the app shell and
 * answers navigations from it when the network is gone, so a cold offline
 * launch paints the real UI (splash → app) and the offline mail cache, the
 * offline outbox and the offline banners finally have a way to be seen.
 *
 * WHAT IT CACHES — and, more importantly, what it does not:
 *   - navigations (the SPA shell HTML) → NETWORK-FIRST, cached copy only as
 *     the offline fallback. Never a stale app: an online user always gets the
 *     freshly served document, so a deploy is picked up on the next load.
 *   - build assets under `/_nuxt/`, `/_fonts/`, `/icons/` → cache-first. Those
 *     URLs are content-hashed, so a hit is always the right bytes.
 *   - EVERYTHING ELSE IS BYPASSED — no `respondWith` at all. Convex traffic is
 *     cross-origin, and `/api/**` (auth proxy, instance control plane) is
 *     explicitly excluded. No mail, no session, no API response ever enters
 *     this cache; the only user data cached offline lives in the IndexedDB
 *     store, behind its own opt-in device preference.
 *
 * VERSIONING. The cache name carries the Nuxt build id read from
 * `/_nuxt/builds/latest.json` (`owlat-shell-<buildId>`), so a new deploy lands
 * in a new cache and every older one is deleted on activation. Offline — when
 * that id cannot be fetched — the newest existing shell cache is reused, which
 * keeps a cold offline start coherent (shell and assets from the same build).
 *
 * NOT SHIPPED ON DESKTOP. This directory is wired into `nitro.publicAssets`
 * only when `OWLAT_DESKTOP !== 'true'` (see nuxt.config.ts), so the Tauri
 * static bundle never contains it, and the client plugin refuses to register
 * on a desktop build, in dev, or when the runtime kill switch is off.
 *
 * PLAIN CLASSIC SCRIPT, ON PURPOSE. No imports and no build step: every global
 * it touches is reached through `self`, so the file that ships is the file the
 * unit test loads and exercises (see app/utils/__tests__/offlineShellWorker.
 * test.ts) via the `self.__owlatShell` seam at the bottom.
 */

/** Cache-name namespace. Everything with this prefix is ours to delete. */
const CACHE_PREFIX = 'owlat-shell-';
/** Cache name suffix used when the build id is unknown (offline first run). */
const FALLBACK_BUILD_ID = 'unversioned';
/** Nuxt's app manifest — `{ id, timestamp }` for the running build. */
const BUILD_MANIFEST_URL = '/_nuxt/builds/latest.json';
/** The single shell entry every navigation falls back to (SPA: one document). */
const SHELL_URL = '/';
/** Fetched at install so a first offline start has something to paint. */
const PRECACHE_URLS = ['/', '/manifest.webmanifest', '/favicon.svg'];
/** Content-hashed build output — safe to serve cache-first. */
const ASSET_PREFIXES = ['/_nuxt/', '/_fonts/', '/icons/'];
/**
 * Never touched. `/api/**` is the auth proxy + control plane (cookie- and
 * secret-bearing), and the build manifest must always be read live or the
 * version check would answer out of its own cache.
 */
const BYPASS_PREFIXES = ['/api/', '/_nuxt/builds/'];

/** Cache name for a build id. */
function cacheNameFor(buildId) {
	return CACHE_PREFIX + buildId;
}

/** Our caches that are not the current one — i.e. previous builds. */
function staleCacheNames(names, current) {
	return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}

/**
 * How a request should be answered: 'navigate' (network-first shell), 'asset'
 * (cache-first) or 'bypass' (the worker does not intervene at all).
 *
 * Pure — takes the fields of a Request plus this worker's origin — so the
 * routing table is testable without a fetch event.
 */
function classifyRequest(input) {
	if (input.method !== 'GET') return 'bypass';
	let url;
	try {
		url = new URL(input.url);
	} catch {
		return 'bypass';
	}
	// Cross-origin: Convex (ws/https), PostHog, iconify. Not ours to cache.
	if (url.origin !== input.origin) return 'bypass';
	if (BYPASS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return 'bypass';
	if (input.mode === 'navigate') return 'navigate';
	if (ASSET_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return 'asset';
	if (PRECACHE_URLS.includes(url.pathname)) return 'asset';
	return 'bypass';
}

/** The running build's id, or null when it cannot be read (offline). */
async function fetchBuildId() {
	try {
		const response = await self.fetch(BUILD_MANIFEST_URL, { cache: 'no-store' });
		if (!response || !response.ok) return null;
		const manifest = await response.json();
		return manifest && typeof manifest.id === 'string' && manifest.id ? manifest.id : null;
	} catch {
		// No network, or an instance that does not emit the manifest.
		return null;
	}
}

/** Delete every shell cache that is not `current` (previous builds). */
async function purgeStaleCaches(current) {
	try {
		const names = await self.caches.keys();
		await Promise.all(staleCacheNames(names, current).map((name) => self.caches.delete(name)));
	} catch {
		// A failed purge only wastes storage; the current cache still answers.
	}
}

/**
 * Resolve the cache to use, purging older builds when the id is known.
 * Offline, fall back to the newest existing shell cache so the cold start is
 * served from one coherent build rather than an empty new namespace.
 */
async function resolveCacheName() {
	const buildId = await fetchBuildId();
	if (buildId) {
		const name = cacheNameFor(buildId);
		await purgeStaleCaches(name);
		return name;
	}
	try {
		const names = (await self.caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX));
		if (names.length > 0) return names[names.length - 1];
	} catch {
		// Fall through to the unversioned name.
	}
	return cacheNameFor(FALLBACK_BUILD_ID);
}

let cacheNamePromise = null;

/** Memoized per worker lifetime — one manifest read per wake-up, not per fetch. */
function currentCacheName() {
	cacheNamePromise ??= resolveCacheName();
	return cacheNamePromise;
}

/** True for a document response worth keeping as the shell. */
function isHtml(response) {
	const type = response.headers && response.headers.get ? response.headers.get('content-type') : '';
	return typeof type === 'string' && type.includes('text/html');
}

/**
 * A navigation response may not be returned with its `redirected` flag set —
 * the browser rejects it — so hand back an equivalent, un-flagged copy.
 */
function stripRedirect(response) {
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/** The newest cached shell document across all our caches, or null. */
async function matchShell() {
	try {
		const names = (await self.caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX));
		for (let index = names.length - 1; index >= 0; index--) {
			const cache = await self.caches.open(names[index]);
			const hit = await cache.match(SHELL_URL);
			if (hit) return hit;
		}
	} catch {
		// Treated as a miss — the navigation fails exactly as it would today.
	}
	return null;
}

/** Network-first: fresh document when online, cached shell when not. */
async function handleNavigate(request) {
	try {
		const response = await self.fetch(request);
		if (response && response.redirected) return stripRedirect(response);
		if (response && response.ok && isHtml(response)) {
			try {
				const cache = await self.caches.open(await currentCacheName());
				await cache.put(SHELL_URL, response.clone());
			} catch {
				// Quota or a blocked cache: serving the live document still works.
			}
		}
		return response;
	} catch (error) {
		const cached = await matchShell();
		if (cached) return cached;
		throw error;
	}
}

/** Cache-first for content-hashed build output. */
async function handleAsset(request) {
	const cache = await self.caches.open(await currentCacheName());
	const hit = await cache.match(request);
	if (hit) return hit;
	const response = await self.fetch(request);
	try {
		if (response && response.ok) await cache.put(request, response.clone());
	} catch {
		// Quota or an uncacheable response; the live response is still returned.
	}
	return response;
}

/** Fill the cache with the shell + its static siblings. Best-effort per URL. */
async function precache() {
	try {
		const cache = await self.caches.open(await currentCacheName());
		await Promise.all(
			PRECACHE_URLS.map(async (url) => {
				try {
					await cache.add(url);
				} catch {
					// One missing file must not fail the whole install.
				}
			})
		);
	} catch {
		// Without a precache the worker still fills its cache from live traffic.
	}
}

self.addEventListener('install', (event) => {
	event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// Re-resolve: a new build may have shipped since this worker last woke.
			cacheNamePromise = null;
			await currentCacheName();
			await self.clients.claim();
		})()
	);
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	const kind = classifyRequest({
		method: request.method,
		mode: request.mode,
		url: request.url,
		origin: self.location.origin,
	});
	if (kind === 'bypass') return;
	event.respondWith(kind === 'navigate' ? handleNavigate(request) : handleAsset(request));
});

// Test seam: the unit test loads this exact file and drives these directly
// against a fake `self` (caches, fetch, clients). Harmless in production — a
// service worker global is not reachable from the page.
self.__owlatShell = {
	CACHE_PREFIX,
	PRECACHE_URLS,
	SHELL_URL,
	cacheNameFor,
	staleCacheNames,
	classifyRequest,
	resolveCacheName,
	matchShell,
	handleNavigate,
	handleAsset,
	precache,
	resetCacheName: () => {
		cacheNamePromise = null;
	},
};
