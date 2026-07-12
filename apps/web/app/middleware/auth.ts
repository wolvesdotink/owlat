import { listOrganizations } from '~/lib/auth-client';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { logError } from '~/lib/runtimeLog';

/**
 * Auth middleware for protecting routes.
 * Redirects unauthenticated users to the login page.
 * Redirects authenticated users without a team to the team setup page.
 *
 * Usage: Add `definePageMeta({ middleware: 'auth' })` to protected pages
 */
export default defineNuxtRouteMiddleware(async (to) => {
	// Only run on client side to avoid SSR hydration issues
	if (import.meta.server) {
		return;
	}

	const { isAuthenticated, user, activeOrganizationId, waitUntilReady } = useAuth();
	await waitUntilReady();

	// If not authenticated and trying to access protected route
	if (!isAuthenticated.value) {
		// Packaged desktop: there is no in-app login form — sign-in happens in the
		// system browser per workspace. An expired/absent session sends the user to
		// the workspace screen to re-connect (which re-runs the browser handshake).
		// In dev the webview loads the local Nuxt dev server and the in-app form
		// signs straight into the auto-seeded local workspace (the cross-domain
		// auth client works against localhost), so fall through to the web
		// login redirect instead of the handshake.
		if (isDesktopRuntime() && !import.meta.dev) {
			return navigateTo('/desktop/welcome');
		}

		// Store the intended destination for redirect after login
		const returnUrl = to.fullPath;

		return navigateTo({
			path: '/auth/login',
			query: returnUrl !== '/' ? { redirect: returnUrl } : undefined,
		});
	}

	// Check if user has an organization (skip for team setup page to avoid redirect loop)
	if (to.path !== '/setup/team') {
		// Only check for team if we have a valid user ID
		if (!user.value?.id) {
			// User is authenticated but no user data yet - allow navigation
			// The page will handle loading states
			return;
		}

		const { isLoading: organizationLoading, organization, setActive } = useOrganizationContext();

		// Wait for organization data to load
		await waitForLoaded(organizationLoading);

		// If user has no active organization, try to auto-activate one they belong to.
		// But if activeOrganizationId is already set, the org data is just loading from
		// the Better Auth hook — don't trigger the expensive list+set+refetch cascade.
		if (!organization.value && !activeOrganizationId.value) {
			try {
				const orgsResult = await listOrganizations();
				const firstOrg = orgsResult.data?.[0];
				if (firstOrg) {
					await setActive(firstOrg.id);
					return;
				}
			} catch (e) {
				if (import.meta.dev) logError('Failed to auto-activate organization:', e);
			}

			// User truly has no organizations - redirect to team setup
			return navigateTo('/setup/team');
		}
	}
});
