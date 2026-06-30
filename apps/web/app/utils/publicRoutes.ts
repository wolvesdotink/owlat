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
	// backend to ask for a session — fetches would hit the desktop auth client's
	// localhost fallback and error-spam the console after every app start.
	// (/desktop/connect is NOT here: it runs in the browser on the instance and
	// performs the actual sign-in.)
	'/desktop/welcome',
	'/desktop/setup',
]);

/**
 * Check if the current route is a public page that doesn't need auth.
 * Safe to call in setup context (uses useRoute).
 */
export function isPublicRoute(): boolean {
	const route = useRoute();
	return PUBLIC_ROUTE_PATHS.has(route.path);
}
