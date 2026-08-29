import {
	SERVICE_WORKER_URL,
	clearShellCaches,
	decideServiceWorkerAction,
	isOwnServiceWorker,
} from '~/utils/offlineShell';

/**
 * Registers (or tears down) the offline app shell service worker — the piece
 * that makes a cold offline start paint the cached UI instead of a blank
 * window. The worker is `service-worker/sw.js`; the decision lives in
 * `~/utils/offlineShell` so it is unit-tested without a browser.
 *
 * Never registers on a desktop build (the Tauri bundle does not even ship the
 * file), in dev (a worker in front of HMR serves yesterday's bundle), or when
 * `NUXT_PUBLIC_OFFLINE_SHELL=false`. In those cases any worker a previous
 * production visit installed on this origin is unregistered and its caches are
 * dropped, so the switch is a real kill switch and not just a skipped install.
 *
 * Registration is deferred to `load`: it must never compete with the first
 * paint or with the Convex subscription that follows it.
 */
export default defineNuxtPlugin(() => {
	const config = useRuntimeConfig();

	const action = decideServiceWorkerAction({
		supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
		isDesktopBuild: config.public.isDesktopBuild === true,
		isDev: import.meta.dev,
		// Absent config (an older baked bundle) means ON — the flag is an opt-OUT.
		enabled: config.public.offlineShell !== false,
	});

	if (action === 'skip') return;

	if (action === 'unregister') {
		void teardown();
		return;
	}

	if (document.readyState === 'complete') void register();
	else window.addEventListener('load', () => void register(), { once: true });
});

/** Best-effort install. A rejected registration must never break the app. */
async function register(): Promise<void> {
	try {
		await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
	} catch {
		// Blocked by policy, served with the wrong MIME type, or an insecure
		// context: the app simply stays online-only.
	}
}

/** Remove any worker this origin installed earlier, plus its caches. */
async function teardown(): Promise<void> {
	try {
		const registrations = await navigator.serviceWorker.getRegistrations();
		await Promise.all(
			registrations.filter(isOwnServiceWorker).map((registration) => registration.unregister())
		);
	} catch {
		// Nothing to unregister, or the API is unavailable.
	}
	await clearShellCaches(typeof caches === 'undefined' ? undefined : caches);
}
