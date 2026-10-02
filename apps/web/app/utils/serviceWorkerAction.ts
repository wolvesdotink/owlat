/**
 * The boot-time decision about the offline app shell service worker, on its own
 * so the client plugin can make it without pulling anything else into the
 * entry chunk. Everything that acts on the decision (register, teardown, the
 * notification-click listener) is `~/lib/serviceWorkerControl`, loaded lazily;
 * the rest of the page-side shell logic is `~/utils/offlineShell`.
 */

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
