import { decideServiceWorkerAction } from '~/utils/serviceWorkerAction';

/**
 * Registers (or tears down) the offline app shell service worker — the piece
 * that makes a cold offline start paint the cached UI instead of a blank
 * window. The worker is `service-worker/sw.js`; the decision lives in
 * `~/utils/serviceWorkerAction` so it is unit-tested without a browser.
 *
 * Never registers on a desktop build (the Tauri bundle does not even ship the
 * file), in dev (a worker in front of HMR serves yesterday's bundle), or when
 * `NUXT_PUBLIC_OFFLINE_SHELL=false`. In those cases any worker a previous
 * production visit installed on this origin is unregistered and its caches are
 * dropped, so the switch is a real kill switch and not just a skipped install.
 *
 * The work is deferred to `load`: it must never compete with the first paint
 * or with the Convex subscription that follows it. Only the decision is in the
 * entry chunk; the runtime (`~/lib/serviceWorkerControl`, with register,
 * teardown and the notification-click listener) is a lazy chunk fetched then.
 *
 * The worker also shows Web Push notifications. A worker that carries a push
 * subscription is therefore never unregistered by the kill switch: it is
 * re-registered push-only (`/sw.js?shell=off`), which drops the shell caches
 * and stops answering fetches but keeps this device's notifications alive.
 * A notification click posts the path to open; the runtime routes it in-app.
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

	const start = () => {
		void import('~/lib/serviceWorkerControl')
			.then(({ startServiceWorker }) => startServiceWorker(action, (path) => void navigateTo(path)))
			.catch(() => {
				// The chunk failed to load (offline, or a deploy replaced it): the app
				// stays as it is, exactly like a blocked registration.
			});
	};

	if (document.readyState === 'complete') start();
	else window.addEventListener('load', start, { once: true });
});
