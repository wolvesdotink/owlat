/**
 * Guest middleware for auth pages.
 * Redirects authenticated users to the dashboard.
 *
 * Usage: Add `definePageMeta({ middleware: 'guest' })` to auth pages (login, register)
 */
export default defineNuxtRouteMiddleware(async (to) => {
	// Only run on client side to avoid SSR hydration issues
	if (import.meta.server) {
		return;
	}

	const { isAuthenticated, waitUntilReady } = useAuth();
	await waitUntilReady();

	// If authenticated and trying to access guest-only route
	if (isAuthenticated.value) {
		return navigateTo(safeRedirect(to.query['redirect'], '/dashboard'));
	}
});
