import { listOrganizations } from '~/lib/auth-client';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { logError } from '~/lib/runtimeLog';

/**
 * Auth middleware for protecting routes.
 * Redirects unauthenticated users to the login page.
 * Redirects authenticated users without an organization to the access-request page.
 *
 * It decides on the session alone (signed in, and which organization is
 * active). It never waits for the member's role: only the `admin` guard needs
 * that, so every other page renders as soon as the session is known.
 *
 * Usage: Add `definePageMeta({ middleware: 'auth' })` to protected pages
 */

/**
 * Where a signed-in member with no organization is sent, and therefore the one
 * path this middleware must not org-check (it would redirect to itself).
 * Named once so the destination and the loop guard cannot drift apart — they did
 * not while this was `/setup/team`, but only because both were the same literal
 * typed twice.
 */
const ACCESS_REQUEST_PATH = '/access-request';
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

	// Check if user has an organization (skip on the access-request page itself to
	// avoid a redirect loop)
	if (to.path !== ACCESS_REQUEST_PATH) {
		// Only check for team if we have a valid user ID
		if (!user.value?.id) {
			// User is authenticated but no user data yet - allow navigation
			// The page will handle loading states
			return;
		}

		// The session is the whole answer here: it names the active organization.
		// Nothing waits for the member role, the member list or the invitation
		// list; only the `admin` guard needs the role, and the page renders
		// skeletons for its role-gated parts meanwhile. Start the role lookup now
		// (one small request) so it is in flight while the page loads.
		useActiveMemberRole();
		if (activeOrganizationId.value) return;

		// No active organization: try to auto-activate one the user belongs to.
		// `useOrganization` is built only on this path — it opens better-auth's
		// organization requests. Its subscriptions are app-lifetime singletons,
		// so building it after an `await` leaks nothing.
		const { setActive } = useOrganization();
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

		// User truly has no organizations - offer them a way to ask for access
		return navigateTo(ACCESS_REQUEST_PATH);
	}
});
