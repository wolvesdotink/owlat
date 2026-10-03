import {
	PUSH_ONLY_WORKER_URL,
	SERVICE_WORKER_URL,
	clearShellCaches,
	decideServiceWorkerAction,
	isOwnServiceWorker,
	navigatePathFrom,
	teardownActionFor,
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
 *
 * The worker also shows Web Push notifications. A worker that carries a push
 * subscription is therefore never unregistered by the kill switch: it is
 * re-registered push-only (`/sw.js?shell=off`), which drops the shell caches
 * and stops answering fetches but keeps this device's notifications alive.
 * A notification click posts the path to open; the listener below routes it
 * in-app.
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

	// A notification click on an already-open window: route in-app rather than
	// reloading it (`sw.js` handleNotificationClick).
	navigator.serviceWorker.addEventListener('message', (event) => {
		const path = navigatePathFrom(event.data);
		if (path) void navigateTo(path);
	});

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

/**
 * Remove any worker this origin installed earlier, plus its caches — except
 * one that carries a push subscription, which is downgraded to push-only so
 * this device keeps its notifications.
 */
async function teardown(): Promise<void> {
	try {
		const registrations = await navigator.serviceWorker.getRegistrations();
		await Promise.all(
			registrations.filter(isOwnServiceWorker).map(async (registration) => {
				const subscription = await registration.pushManager?.getSubscription().catch(() => null);
				if (teardownActionFor(!!subscription) === 'downgrade') {
					await navigator.serviceWorker.register(PUSH_ONLY_WORKER_URL, { scope: '/' });
				} else {
					await registration.unregister();
				}
			})
		);
	} catch {
		// Nothing to unregister, or the API is unavailable.
	}
	await clearShellCaches(typeof caches === 'undefined' ? undefined : caches);
}
