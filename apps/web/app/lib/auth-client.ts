import { createAuthClient } from 'better-auth/vue';
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
import { organizationClient } from 'better-auth/client/plugins';
import { isDesktopRuntime, getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { keychainStorage } from '~/lib/desktop/keychainStorage';

// Web (default): auth requests are proxied to Convex via same-origin (see:
// server/api/auth/[...].ts). Use window.location.origin on client; fall back to
// env var / localhost for SSR.
function createWebAuthClient() {
	const siteUrl =
		typeof window !== 'undefined'
			? window.location.origin
			: (globalThis.process?.env?.['NUXT_PUBLIC_SITE_URL'] || 'http://localhost:3000');
	return createAuthClient({
		baseURL: siteUrl,
		plugins: [convexClient(), organizationClient()],
	});
}

// Desktop (Tauri): there is no local Nitro proxy and cookies don't survive the
// `tauri://localhost` → instance cross-origin hop, so we talk directly to the
// active workspace's Convex site URL (where /api/auth/* lives) and carry the
// session in the `Better-Auth-Cookie` header via the cross-domain plugin,
// persisted in the OS keychain. The active workspace is seeded by the boot
// plugin (plugins/0.desktop-workspace.client.ts) before this module is first
// imported; switching workspace reloads the webview, reconstructing this client.
// Cast to the web client's type so the ~10 consumers + `$Infer` are unchanged —
// the desktop client is a structural superset (adds cross-domain actions).
export const authClient: ReturnType<typeof createWebAuthClient> = isDesktopRuntime()
	? (createAuthClient({
			baseURL: getActiveWorkspace()?.convexSiteUrl || 'http://localhost:3211',
			plugins: [
				convexClient(),
				organizationClient(),
				crossDomainClient({ storage: keychainStorage }),
			],
		}) as unknown as ReturnType<typeof createWebAuthClient>)
	: createWebAuthClient();

export type AuthSessionData = typeof authClient.$Infer.Session;

// Export individual auth methods for convenience
export const { signIn, signUp, signOut, useSession, getSession } = authClient;

// Export organization-related methods.
// Owlat is single-organization-per-deployment — the singleton org is bootstrapped
// by `/seed/admin` on apps/api. Creating additional orgs is disabled at the
// BetterAuth plugin level (`allowUserToCreateOrganization: false`) so we do not
// re-export `organization.create` or `organization.delete` from the client.
export const {
	organization: {
		update: updateOrganization,
		getFullOrganization,
		list: listOrganizations,
		setActive: setActiveOrganization,
		checkSlug: checkOrgSlug,
		inviteMember,
		acceptInvitation,
		rejectInvitation,
		cancelInvitation,
		removeMember,
		updateMemberRole,
		getActiveMember,
		listMembers,
		listInvitations,
		leave: leaveOrganization,
	},
	useListOrganizations,
	useActiveOrganization,
} = authClient;
