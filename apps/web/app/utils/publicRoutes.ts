import { readonly, ref, watch, type Ref } from 'vue';

/**
 * Route paths that are public (no auth needed).
 * These pages use layout: false and make direct API calls — they should
 * never trigger session fetches, Convex auth tokens, or org queries.
 */
const PUBLIC_ROUTE_PATHS = new Set([
	'/share',
	'/archive',
	'/unsubscribe',
	'/preferences',
	'/confirm',
	'/terms',
	'/imprint',
	'/cancel-deletion',
	// Desktop pre-auth screens: no workspace is connected yet, so there is no
	// backend to ask for a session.
	// (/desktop/connect is NOT here: it runs in the browser on the instance and
	// performs the actual sign-in.)
	'/desktop/welcome',
	'/desktop/setup',
]);

/**
 * Path prefixes whose every page is public: the booking pages
 * (`/book/<host>`, `/book/<host>/<meeting>`, `/book/manage`).
 */
const PUBLIC_ROUTE_PREFIXES = ['/book/'];

/** Whether a route path is a public page that doesn't need auth. */
export function isPublicPath(path: string): boolean {
	return (
		PUBLIC_ROUTE_PATHS.has(path) || PUBLIC_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix))
	);
}

/**
 * Check if the current route is a public page that doesn't need auth.
 * Safe to call in setup context (uses useRoute).
 */
export function isPublicRoute(): boolean {
	const route = useRoute();
	return isPublicPath(route.path);
}

/**
 * True once the app has been on a route that is not public: from boot on an app
 * route, or from the first navigation that leaves the public pages (a link from
 * /terms into the app). It never turns back to false. Lets session-dependent
 * setup start late for a visit that began on a public page, where a check made
 * once at boot would leave it off until a reload. Setup context only.
 */
export function useLeftPublicPages(): Readonly<Ref<boolean>> {
	const route = useRoute();
	const left = ref(!isPublicPath(route.path));
	if (!left.value) {
		const stop = watch(
			() => route.path,
			(path) => {
				if (isPublicPath(path)) return;
				left.value = true;
				stop();
			}
		);
	}
	return readonly(left);
}
