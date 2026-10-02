/**
 * The page-side runtime of the offline app shell service worker: register it,
 * tear it down, and route the notification clicks it posts.
 *
 * `plugins/service-worker.client.ts` makes the decision on boot (with
 * `~/utils/serviceWorkerAction`, the only part of this the entry chunk carries)
 * and loads this module with a dynamic `import()` on `load`. Every page, the
 * sign-in page included, would otherwise download and parse it before Vue
 * mounts, for work that must wait until after the first paint anyway.
 */
import { SERVICE_WORKER_URL, clearShellCaches, isOwnServiceWorker } from '~/utils/offlineShell';
import { PUSH_ONLY_WORKER_URL, navigatePathFrom, teardownActionFor } from '~/utils/webPush';

/**
 * Act on the plugin's decision. Best-effort throughout: a blocked registration
 * or a failing teardown leaves the app online-only and never rejects.
 *
 * A notification click on an already-open window posts the path to open
 * (`sw.js` handleNotificationClick); `navigate` routes it in-app rather than
 * reloading the window.
 */
export async function startServiceWorker(
	action: 'register' | 'unregister',
	navigate: (path: string) => void
): Promise<void> {
	navigator.serviceWorker.addEventListener('message', (event) => {
		const path = navigatePathFrom(event.data);
		if (path) navigate(path);
	});

	if (action === 'unregister') await teardown();
	else await register();
}

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
