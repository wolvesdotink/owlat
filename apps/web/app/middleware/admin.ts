/**
 * Organization-admin route guard. Pair with `auth` on privileged pages.
 * It waits for the active organization role before deciding, so owners/admins
 * never flash a denial shell and editor deep links fail closed to Home.
 */
export default defineNuxtRouteMiddleware(async () => {
	if (import.meta.server) return;

	const { isAuthenticated, waitUntilReady } = useAuth();
	await waitUntilReady();
	if (!isAuthenticated.value) return navigateTo('/auth/login');

	// Below the auth check on purpose: the organization context opens better-auth's
	// organization requests, and a signed-out visitor would only collect 401s from
	// them on the way to the login redirect. Building it after an `await` — where
	// the guard's effect scope is gone — leaks nothing, because the subscriptions
	// underneath are app-lifetime singletons.
	const { isLoading } = useOrganizationContext();
	const { isAdmin } = usePermissions();
	await waitForLoaded(isLoading);
	if (!isAdmin.value) return navigateTo('/dashboard', { replace: true });
});
