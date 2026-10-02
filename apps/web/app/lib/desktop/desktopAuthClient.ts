/**
 * The desktop auth client for a workspace (Tauri), and the fences that keep a
 * replaced session safe from answers to requests sent with it. Loaded on
 * demand by desktop hydration (`loadWorkspaces`) and the connect handshake,
 * never by the web app.
 */
import { createAuthClient } from 'better-auth/vue';
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import type { AuthClient, FetchImpl } from '~/lib/auth-client';
import {
	activeSessionStorage,
	getActiveKeychainStorage,
	getSessionGeneration,
	onSessionRebound,
	type KeychainSessionStorage,
} from '~/lib/desktop/keychainStorage';

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
	fetchImpl?: FetchImpl,
	boundStorage?: () => SessionStorageLike | null
): AuthClient {
	const crossDomain = crossDomainClient({ storage });
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
			boundStorage ? bindCrossDomainToRequest(crossDomain, boundStorage) : crossDomain,
		],
	}) as unknown as AuthClient;
}

type SessionStorageLike = Pick<KeychainSessionStorage, 'getItem' | 'setItem'>;

/** Where an auth request keeps the session storage it went out with. */
const SENT_WITH_STORAGE = 'owlatSessionStorage';

type CrossDomainPlugin = ReturnType<typeof crossDomainClient>;
type FetchOptions = Record<string, unknown>;
/** The parts of a better-fetch plugin the binding wraps. */
interface BoundFetchPlugin {
	init?: (url: string, options?: FetchOptions) => Promise<{ url: string; options?: FetchOptions }>;
	hooks?: { onSuccess?: (context: { request: unknown }) => unknown } & Record<string, unknown>;
}

/**
 * The cross-domain plugin reads the cookie a request sends from the storage
 * in its `init`, and writes what the answer says about the session (cookie,
 * session data, a cleared cookie on a signed-out answer) into the storage in
 * its `onSuccess`, across several awaits. Another window can sign in to the
 * workspace again while a request is in flight; the page then retires the
 * storage that request went out with and binds a new one
 * (`rebindActiveSession`). Writing through `activeSessionStorage` would let
 * whatever part of the hook runs after that land in the new session.
 *
 * So each request is bound to the storage it went out with, for its whole
 * life: `init` records the page's bound storage on the request, and both hooks
 * run on a plugin built for that storage alone. Every write of the answer goes
 * to the storage the request was sent with; if that has been retired since,
 * it is never written to the keychain, whenever in the hook the rebind lands.
 * The plugin's actions (`getCookie`, `getSessionData`) and its store stay on
 * the facade, so the client keeps one session state.
 */
function bindCrossDomainToRequest(
	facade: CrossDomainPlugin,
	boundStorage: () => SessionStorageLike | null
): CrossDomainPlugin {
	const facadeFetchPlugins = (facade.fetchPlugins ?? []) as BoundFetchPlugin[];
	// The client's store, handed to each per-storage plugin so its session
	// signal and sign-out reach the same atoms as the facade's.
	let clientStore: unknown;
	const perStorage = new WeakMap<object, BoundFetchPlugin[]>();
	const fetchPluginsFor = (target: SessionStorageLike | undefined): BoundFetchPlugin[] => {
		if (!target) return facadeFetchPlugins;
		let plugins = perStorage.get(target);
		if (!plugins) {
			const plugin = crossDomainClient({ storage: target });
			(plugin.getActions as ((...args: unknown[]) => unknown) | undefined)?.(
				undefined,
				clientStore
			);
			plugins = (plugin.fetchPlugins ?? []) as BoundFetchPlugin[];
			perStorage.set(target, plugins);
		}
		return plugins;
	};

	return {
		...facade,
		getActions: (...args: unknown[]) => {
			clientStore = args[1];
			return (facade.getActions as (...a: unknown[]) => unknown)(...args);
		},
		fetchPlugins: facadeFetchPlugins.map((fetchPlugin, index) => {
			const init: NonNullable<BoundFetchPlugin['init']> = async (url, options) => {
				const target = boundStorage() ?? undefined;
				const own = fetchPluginsFor(target)[index];
				const result = own?.init ? await own.init(url, options) : { url, options };
				// On the options object itself, as the plugin sets its headers:
				// better-fetch hands every plugin the same options and keeps the
				// last one's result.
				const stamped = result.options ?? options ?? {};
				stamped[SENT_WITH_STORAGE] = target;
				if (options && options !== stamped) options[SENT_WITH_STORAGE] = target;
				return { ...result, options: stamped };
			};
			const onSuccess: NonNullable<NonNullable<BoundFetchPlugin['hooks']>['onSuccess']> = async (
				context
			) => {
				const target = (context.request as FetchOptions)[SENT_WITH_STORAGE] as
					| SessionStorageLike
					| undefined;
				await fetchPluginsFor(target)[index]?.hooks?.onSuccess?.(context);
			};
			return { ...fetchPlugin, init, hooks: { ...fetchPlugin.hooks, onSuccess } };
		}),
	} as unknown as CrossDomainPlugin;
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
 * The fetch for a workspace's auth client. Besides the binding above, an
 * answer to a request sent with a session that has since been replaced must
 * not reach the client's own session state either, where a signed-out answer
 * would read as "signed out" in this window. The whole body is read here, and
 * the response is handed on only if the session generation it went out under
 * is still the one bound.
 */
export function sessionFencedFetch(
	sessionGeneration: () => number,
	fetchImpl: FetchImpl = (input, init) => fetch(input, init)
): FetchImpl {
	return async (input, init) => {
		const sentAt = sessionGeneration();
		const response = await fetchImpl(input, init);
		const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.arrayBuffer();
		if (sessionGeneration() !== sentAt) throw new StaleSessionResponseError();
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

/**
 * The client for the workspace this page is signed in to: on the page's
 * session storage, whichever is bound, with every request bound to the storage
 * it went out with and answers to a replaced session dropped. When another
 * window replaces the session, the client fires `$sessionSignal`, so
 * useSession refetches and the Convex token and the Postbox body cache follow.
 */
export function createActiveDesktopAuthClient(convexSiteUrl: string): AuthClient {
	const client = createDesktopAuthClient(
		convexSiteUrl,
		activeSessionStorage,
		sessionFencedFetch(getSessionGeneration),
		getActiveKeychainStorage
	);
	onSessionRebound(() => client.$store.notify('$sessionSignal'));
	return client;
}
