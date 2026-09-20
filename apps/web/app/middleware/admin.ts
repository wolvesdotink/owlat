/**
 * Organization-admin route guard. Pair with `auth` on privileged pages.
 * It waits for the active organization role before deciding, so owners/admins
 * never flash a denial shell and editor deep links fail closed to Home.
 */
export default defineNuxtRouteMiddleware(async () => {
	if (import.meta.server) return;

	// Every composable is built in the SYNCHRONOUS prologue: a route guard runs
	// under `runWithContext`, whose effect scope stops being active at the first
	// `await`, and composables that subscribe to something would then have
	// nothing to register their teardown on.
	const { isAuthenticated, waitUntilReady } = useAuth();
	const { isLoading } = useOrganizationContext();
	const { isAdmin } = usePermissions();

	await waitUntilReady();
	if (!isAuthenticated.value) return navigateTo('/auth/login');

	await waitForLoaded(isLoading);
	if (!isAdmin.value) return navigateTo('/dashboard', { replace: true });
});
