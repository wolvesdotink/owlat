import { createAuthClient } from 'better-auth/vue';
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { isDesktopRuntime, getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import {
	getActiveKeychainStorage,
	type KeychainSessionStorage,
} from '~/lib/desktop/keychainStorage';

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

type AuthClient = ReturnType<typeof createWebAuthClient>;
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * An auth client for one desktop workspace (Tauri). There is no local Nitro
 * proxy and cookies don't survive the `tauri://localhost` → instance
 * cross-origin hop, so it talks directly to the workspace's Convex site URL
 * (where /api/auth/* lives) and carries the session in the `Better-Auth-Cookie`
 * header via the cross-domain plugin, kept in `storage`.
 *
 * `storage` must belong to this workspace alone: the client reads the session
 * it sends from there and writes every session the server returns back into
 * it. Also used by the connect handshake for the instance being added.
 *
 * Cast to the web client's type so the ~10 consumers + `$Infer` are unchanged —
 * the desktop client is a structural superset (adds cross-domain actions).
 */
export function createDesktopAuthClient(
	convexSiteUrl: string,
	storage: Pick<KeychainSessionStorage, 'getItem' | 'setItem'>,
	fetchImpl?: FetchImpl
): AuthClient {
	return createAuthClient({
		baseURL: convexSiteUrl,
		...(fetchImpl ? { fetchOptions: { customFetchImpl: fetchImpl } } : {}),
		plugins: [
			convexClient(),
			organizationClient(),
			// No `onTwoFactorRedirect` / `twoFactorPage` on either client: the
			// challenge is a STEP inside the login form, not a route. Configuring
			// a redirect here would navigate away mid-submit and strand the
			// desktop app, which has no such route to navigate to.
			twoFactorClient(),
			crossDomainClient({ storage }),
		],
	}) as unknown as AuthClient;
}

/**
 * Thrown in place of an auth response whose request went out with a session
 * that has since been replaced.
 */
export class StaleSessionResponseError extends Error {
	constructor() {
		super('The session changed while this auth request was in flight.');
		this.name = 'StaleSessionResponseError';
	}
}

/** Statuses whose responses carry no body (the Fetch spec's null-body statuses). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The fetch for a workspace's auth client. Another window can sign in to the
 * workspace again while a request this window sent with the older session is
 * in flight. The window then retires the storage that session lives in and
 * binds a new one (`rebindActiveSession`), so the old client's writes can no
 * longer reach the keychain. This keeps the old answer from reaching the old
 * client as well: the whole body is read here, and the response is handed on
 * only if `storage` is still the page's session storage once it has arrived.
 * Otherwise a signed-out answer to the old session would still read as
 * "signed out" in this window.
 */
export function sessionFencedFetch(
	storage: KeychainSessionStorage,
	fetchImpl: FetchImpl = (input, init) => fetch(input, init),
	isCurrent: () => boolean = () => getActiveKeychainStorage() === storage
): FetchImpl {
	return async (input, init) => {
		if (!isCurrent()) throw new StaleSessionResponseError();
		const response = await fetchImpl(input, init);
		const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
		if (!isCurrent()) throw new StaleSessionResponseError();
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

/**
 * Desktop with no workspace connected: there is no backend to ask. Answer every
 * auth request locally, as "no session", instead of sending it anywhere.
 */
const disconnectedFetch: FetchImpl = async () =>
	new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });

const disconnectedStorage = {
	getItem: () => null,
	setItem: () => {},
};

/** A desktop client and the workspace endpoint + session it is bound to. */
interface DesktopBinding {
	client: AuthClient;
	/** The workspace's Convex site URL, or null for the disconnected client. */
	convexSiteUrl: string | null;
	/** The session storage the client was built on (null when disconnected). */
	storage: KeychainSessionStorage | null;
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
 * Switching workspace reloads the webview. Within a page the binding is rebuilt
 * only when another window replaced the session and the page bound a new
 * session storage (`rebindActiveSession`).
 * With no workspace connected (or a call before hydration) the answer is a
 * disconnected client that sends nothing; it is kept apart from the workspace
 * binding, so it cannot pin the page to "no workspace".
 */
function desktopClient(): DesktopBinding {
	const storage = getActiveKeychainStorage();
	// Rebuilt when the session was replaced from another window: the old client
	// keeps the retired storage, the page moves on to the new one.
	if (desktopBinding && desktopBinding.storage === storage) return desktopBinding;
	const workspace = getActiveWorkspace();
	if (!workspace || !storage || storage.accountKey !== workspace.tokenRef) {
		disconnectedBinding ??= {
			client: createDesktopAuthClient(
				'http://disconnected.invalid',
				disconnectedStorage,
				disconnectedFetch
			),
			convexSiteUrl: null,
			storage: null,
		};
		return disconnectedBinding;
	}
	desktopBinding = {
		client: createDesktopAuthClient(workspace.convexSiteUrl, storage, sessionFencedFetch(storage)),
		convexSiteUrl: workspace.convexSiteUrl,
		storage,
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
