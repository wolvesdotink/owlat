/**
 * Page-side control of the offline app shell service worker (plan idea 49).
 *
 * The worker itself lives in `service-worker/sw.js` (a plain classic script,
 * shipped as a public asset). This module holds the two decisions the app makes
 * ABOUT it, kept pure so they are testable without a browser:
 *
 *   - {@link decideServiceWorkerAction} — register, actively unregister, or do
 *     nothing. "Unregister" is the load-bearing branch: a worker installed by a
 *     production visit outlives the flag that installed it, so turning the kill
 *     switch off (or opening the dev server on the same origin) must REMOVE the
 *     installed worker, not merely skip registration.
 *   - {@link clearShellCaches} — drop every `owlat-shell-*` CacheStorage entry.
 *     The page shares CacheStorage with the worker, so the teardown needs no
 *     message plumbing and works even when the worker is already gone.
 *
 * No mail is ever in these caches (the worker bypasses `/api/**` and every
 * cross-origin request); the offline MAIL cache is `postboxOfflineStore.ts`.
 */

/** Scope-root URL of the worker script, as served from `nitro.publicAssets`. */
export const SERVICE_WORKER_URL = '/sw.js';

/** Cache-name prefix owned by the worker — mirrored from `service-worker/sw.js`. */
export const SHELL_CACHE_PREFIX = 'owlat-shell-';

/** What the client plugin should do on boot. */
export type ServiceWorkerAction = 'register' | 'unregister' | 'skip';

export interface ServiceWorkerEnv {
	/** `'serviceWorker' in navigator` — false in unsupported or non-secure contexts. */
	supported: boolean;
	/** `runtimeConfig.public.isDesktopBuild` — the Tauri bundle never registers. */
	isDesktopBuild: boolean;
	/** `import.meta.dev` — a worker in front of HMR serves yesterday's bundle. */
	isDev: boolean;
	/** `runtimeConfig.public.offlineShell` — the operator kill switch. */
	enabled: boolean;
}

/**
 * Decide what to do with the offline shell worker.
 *
 * `skip` only when service workers are unavailable — there is nothing to
 * register and nothing that could have been registered. Every other "off"
 * reason returns `unregister`, so a previously installed worker is torn down
 * instead of quietly surviving the setting that disabled it.
 */
export function decideServiceWorkerAction(env: ServiceWorkerEnv): ServiceWorkerAction {
	if (!env.supported) return 'skip';
	if (env.isDesktopBuild || env.isDev || !env.enabled) return 'unregister';
	return 'register';
}

/** The three slots a registration can hold its script in, in install order. */
export interface ServiceWorkerLike {
	scriptURL: string;
}
export interface RegistrationLike {
	active?: ServiceWorkerLike | null;
	waiting?: ServiceWorkerLike | null;
	installing?: ServiceWorkerLike | null;
}

/**
 * True when `registration` is OUR shell worker. Checked across all three
 * slots: a registration caught mid-install has no `active` worker yet, and
 * teardown must still remove it. Other origins' workers (a reverse proxy, a
 * plugin) are left alone.
 */
export function isOwnServiceWorker(registration: RegistrationLike): boolean {
	const urls = [registration.active, registration.waiting, registration.installing];
	return urls.some(
		(worker) => !!worker && new URL(worker.scriptURL).pathname === SERVICE_WORKER_URL
	);
}

/** i18n key prefix for the settings row that reports the worker's state. */
const SHELL_STATUS_PREFIX = 'components.postbox.postboxOfflineSettings.shell.';

export interface ShellStatusEnv extends ServiceWorkerEnv {
	/** `navigator.serviceWorker.controller != null` — a worker is serving this page. */
	controlled: boolean;
}

/**
 * The one line the settings screen shows about offline start, as an i18n KEY
 * (module-scope registry convention — a pure module never calls `useI18n`).
 *
 * `null` on a desktop build: the app is already installed locally there, so
 * "can this open without a connection" is not a question worth asking, and the
 * row hides itself rather than explaining a worker that will never exist.
 */
export function describeShellStatus(env: ShellStatusEnv): { key: string } | null {
	if (env.isDesktopBuild) return null;
	// Same decision the plugin acts on, so the row can never claim a state the
	// registration logic disagrees with (dev included: no worker runs there).
	const action = decideServiceWorkerAction(env);
	if (action === 'skip') return { key: `${SHELL_STATUS_PREFIX}unsupported` };
	if (action === 'unregister') return { key: `${SHELL_STATUS_PREFIX}disabled` };
	// Registered but not yet in control: the worker takes over on the next load.
	return { key: `${SHELL_STATUS_PREFIX}${env.controlled ? 'ready' : 'pending'}` };
}

/**
 * Delete every shell cache. Returns how many were dropped; a CacheStorage that
 * throws (privacy mode, no secure context) yields 0 rather than raising —
 * teardown is best-effort by design.
 */
export async function clearShellCaches(cacheStorage: CacheStorage | undefined): Promise<number> {
	if (!cacheStorage) return 0;
	try {
		const names = await cacheStorage.keys();
		const ours = names.filter((name) => name.startsWith(SHELL_CACHE_PREFIX));
		const results = await Promise.all(ours.map((name) => cacheStorage.delete(name)));
		return results.filter(Boolean).length;
	} catch {
		return 0;
	}
}
