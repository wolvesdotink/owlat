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

	const { isLoading } = useOrganizationContext();
	await waitForLoaded(isLoading);
	const { isAdmin } = usePermissions();
	if (!isAdmin.value) return navigateTo('/dashboard', { replace: true });
});
