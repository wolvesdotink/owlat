import { createAuthClient } from 'better-auth/vue';
import { convexClient } from '@convex-dev/better-auth/client/plugins';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { isDesktopRuntime, getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { getActiveKeychainStorage } from '~/lib/desktop/keychainStorage';
import { getDesktopAuthClientFactory } from '~/lib/desktop/desktopAuthClientFactory';

// Web (default): auth requests are proxied to Convex via same-origin (see:
// server/api/auth/[...].ts). Use window.location.origin on client; fall back to
// env var / localhost for SSR.
function createWebAuthClient() {
	const siteUrl =
		typeof window !== 'undefined'
			? window.location.origin
			: globalThis.process?.env?.['NUXT_PUBLIC_SITE_URL'] || 'http://localhost:3000';
	return createAuthClient({
		baseURL: siteUrl,
		plugins: [convexClient(), organizationClient(), twoFactorClient()],
	});
}

export type AuthClient = ReturnType<typeof createWebAuthClient>;
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Desktop with no workspace connected: there is no backend to ask. Answer every
 * auth request locally, as "no session", instead of sending it anywhere.
 */
const disconnectedFetch: FetchImpl = async () =>
	new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });

/** A desktop client and the workspace endpoint + session it is bound to. */
interface DesktopBinding {
	client: AuthClient;
	/** The workspace's Convex site URL, or null for the disconnected client. */
	convexSiteUrl: string | null;
}

let webClient: AuthClient | null = null;
let desktopBinding: DesktopBinding | null = null;
let disconnectedBinding: DesktopBinding | null = null;

/**
 * The desktop client for the active workspace, built on first use.
 *
 * Desktop auth depends on the active workspace, which the boot plugin
 * (plugins/0.desktop-workspace.client.ts) only knows after an async keychain and
 * store read. Plugin files are imported (and this module evaluated) before any
 * plugin runs, so nothing may be constructed at import time: the client is
 * built on the first auth call, which the boot order places after hydration.
 * Switching workspace reloads the webview, so the binding holds for the page.
 * When another window replaces the session, the page binds a new session
 * storage under the same client (`activeSessionStorage`), so everything
 * subscribed to the client stays attached, and is told through
 * `$sessionSignal`.
 * With no workspace connected (or a call before hydration) the answer is a
 * disconnected client that sends nothing; it is kept apart from the workspace
 * binding, so it cannot pin the page to "no workspace". The workspace client
 * itself is built by `lib/desktop/desktopAuthClient.ts`, which hydration loads
 * on demand so the web app never downloads it.
 */
function desktopClient(): DesktopBinding {
	if (desktopBinding) return desktopBinding;
	const workspace = getActiveWorkspace();
	const storage = getActiveKeychainStorage();
	const createActiveClient = getDesktopAuthClientFactory<AuthClient>();
	if (!workspace || !storage || storage.accountKey !== workspace.tokenRef || !createActiveClient) {
		disconnectedBinding ??= {
			client: createAuthClient({
				baseURL: 'http://disconnected.invalid',
				fetchOptions: { customFetchImpl: disconnectedFetch },
				plugins: [convexClient(), organizationClient(), twoFactorClient()],
			}),
			convexSiteUrl: null,
		};
		return disconnectedBinding;
	}
	desktopBinding = {
		client: createActiveClient(workspace.convexSiteUrl),
		convexSiteUrl: workspace.convexSiteUrl,
	};
	return desktopBinding;
}

/** The auth client for this page: the web client, or the active workspace's. */
function getAuthClient(): AuthClient {
	if (isDesktopRuntime()) return desktopClient().client;
	webClient ??= createWebAuthClient();
	return webClient;
}

/**
 * Where the Convex JWT for the active desktop workspace is fetched from, and
 * the session to present there — both taken from the SAME bound client, so the
 * token request can never pair one workspace's endpoint with another's
 * session. Null when no workspace is connected.
 */
export function desktopConvexTokenRequest(): { convexSiteUrl: string; cookie: string } | null {
	const { client, convexSiteUrl } = desktopClient();
	if (!convexSiteUrl) return null;
	const getCookie = (client as unknown as { getCookie?: () => string }).getCookie;
	return { convexSiteUrl, cookie: getCookie ? getCookie() : '' };
}

/**
 * A stand-in that resolves `resolve()` on every use rather than at import time.
 * Property reads and calls both forward, so `signIn.email(...)`,
 * `getSession()` and `authClient.$store` behave as on the real client.
 */
function deferred<T>(resolve: () => T): T {
	return new Proxy(() => {}, {
		// better-auth's client methods do not use `this`, so a value is handed out
		// as is rather than re-bound.
		get: (_target, prop) => Reflect.get(resolve() as object, prop),
		apply: (_target, _this, args) =>
			Reflect.apply(resolve() as (...a: unknown[]) => unknown, undefined, args),
		has: (_target, prop) => Reflect.has(resolve() as object, prop),
	}) as unknown as T;
}

export const authClient: AuthClient = deferred(getAuthClient);

export type AuthSessionData = AuthClient['$Infer']['Session'];

// Export individual auth methods for convenience. Each resolves the client when
// it is used, not when this module loads (see `desktopClient`).
export const signIn = deferred(() => getAuthClient().signIn);
export const signUp = deferred(() => getAuthClient().signUp);
export const signOut = deferred(() => getAuthClient().signOut);
export const useSession = deferred(() => getAuthClient().useSession);
export const getSession = deferred(() => getAuthClient().getSession);

// Export organization-related methods.
// Owlat is single-organization-per-deployment — the singleton org is bootstrapped
// by `/seed/admin` on apps/api. Creating additional orgs is disabled at the
// BetterAuth plugin level (`allowUserToCreateOrganization: false`) so we do not
// re-export `organization.create` or `organization.delete` from the client.
const organization = () => getAuthClient().organization;
export const updateOrganization = deferred(() => organization().update);
export const getFullOrganization = deferred(() => organization().getFullOrganization);
export const listOrganizations = deferred(() => organization().list);
export const setActiveOrganization = deferred(() => organization().setActive);
export const checkOrgSlug = deferred(() => organization().checkSlug);
export const inviteMember = deferred(() => organization().inviteMember);
export const acceptInvitation = deferred(() => organization().acceptInvitation);
export const rejectInvitation = deferred(() => organization().rejectInvitation);
export const cancelInvitation = deferred(() => organization().cancelInvitation);
export const removeMember = deferred(() => organization().removeMember);
export const updateMemberRole = deferred(() => organization().updateMemberRole);
export const getActiveMember = deferred(() => organization().getActiveMember);
export const listMembers = deferred(() => organization().listMembers);
export const listInvitations = deferred(() => organization().listInvitations);
export const leaveOrganization = deferred(() => organization().leave);
export const useListOrganizations = deferred(() => getAuthClient().useListOrganizations);
export const useActiveOrganization = deferred(() => getAuthClient().useActiveOrganization);
