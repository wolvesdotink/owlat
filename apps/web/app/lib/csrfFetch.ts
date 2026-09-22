/**
 * `$fetch`, with nuxt-csurf's token on it.
 *
 * Every same-origin POST/PUT/PATCH the app makes has to carry a `csrf-token`
 * header or the middleware 403s it before the route handler runs — see
 * `~/lib/csrf` for the rules and for what that broke.
 *
 * Why an explicit wrapper and not a plugin that patches the global: Nuxt's
 * auto-imported `$fetch` is NOT the global. `#build/fetch.mjs` is
 *
 *     if (!globalThis.$fetch) { globalThis.$fetch = _$fetch.create({ baseURL: baseURL() }) }
 *     export const $fetch = globalThis.$fetch
 *
 * — a `const` captured when that module evaluates, which is before any plugin
 * runs. Reassigning `globalThis.$fetch` later changes nothing for a call site
 * that auto-imported the binding, and the built chunks show exactly that. So
 * call sites import this instead, and `app/__tests__/noRawApiFetch.test.ts`
 * fails the build when one of them forgets.
 *
 * It resolves `globalThis.$fetch` per call rather than capturing it, so this
 * stays the very instance Nuxt configured (app `baseURL` and all) and test
 * stubs still take effect.
 *
 * It also heals a STALE token: nuxt-csurf's token is only minted while
 * rendering an HTML document, and this app is `ssr:false`, so a tab renders one
 * document and then holds that token for its whole life — until an in-app
 * update promotes a `web` image whose build-time encrypt secret is a different
 * one, at which point the token stops verifying and every POST from that tab
 * 403s. A rejection at the CSRF middleware is answered here by minting a fresh
 * token and sending the request once more.
 */
import type { FetchOptions, FetchResponse } from 'ofetch';
import {
	isCsrfRejection,
	readCsrfToken,
	shouldAttachCsrfToken,
	withCsrfHeader,
	writeCsrfToken,
} from './csrf';

/** nuxt-csurf's `headerName` default, which nuxt.config leaves in place. */
const DEFAULT_CSRF_HEADER = 'csrf-token';

function csrfHeaderName(): string {
	try {
		return useRuntimeConfig().public.csurf?.headerName || DEFAULT_CSRF_HEADER;
	} catch {
		// `useRuntimeConfig()` reaches for the Nuxt instance, which a caller
		// running off a timer may no longer be inside. The module default is what
		// the config resolves to anyway; it is only wrong if someone renames the
		// header, and `nuxt.config.ts` does not.
		return DEFAULT_CSRF_HEADER;
	}
}

function decorate(request: string, options?: FetchOptions): FetchOptions {
	const resolved = options ?? {};
	if (
		!shouldAttachCsrfToken({
			request,
			method: resolved.method,
			baseURL: resolved.baseURL,
			href: window.location.href,
		})
	) {
		return resolved;
	}
	// Read per request: the token is only in the document once the SPA shell has
	// been rendered by the server, and a caller may outlive the page that was.
	const token = readCsrfToken(window.document);
	return token ? withCsrfHeader(resolved, csrfHeaderName(), token) : resolved;
}

/**
 * ofetch's runtime shape, without the route-literal generics Nitro layers on
 * top of the global `$fetch`. Those generics exist to type a response from a
 * known route; instantiating them here only re-derives what the caller already
 * states, and does so deeply enough that tsc gives up (TS2321). Erasing them at
 * this one boundary keeps `ApiFetch`'s own signature honest.
 */
interface FetchInstance {
	(request: string, options?: FetchOptions): Promise<unknown>;
	raw(request: string, options?: FetchOptions): Promise<FetchResponse<unknown>>;
}

function nuxtFetch(): FetchInstance {
	return globalThis.$fetch as unknown as FetchInstance;
}

export interface ApiFetch {
	<T = unknown>(request: string, options?: FetchOptions): Promise<T>;
	/** The response itself — for a caller that needs the status, not the body. */
	raw<T = unknown>(request: string, options?: FetchOptions): Promise<FetchResponse<T>>;
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Replace the document's token with a freshly minted one, at most one refresh
 * per burst: a page that fires several POSTs at once (the setup wizard does)
 * would otherwise have the later ones compare against a token the earlier ones
 * already installed, read "nothing changed", and rethrow a 403 the retry would
 * have cleared.
 */
function refreshCsrfToken(): Promise<boolean> {
	refreshInFlight ??= fetchCsrfToken().finally(() => {
		refreshInFlight = null;
	});
	return refreshInFlight;
}

/**
 * Ask the server for a live token and install it, reporting whether anything
 * changed.
 *
 * A token goes stale on its own: it is the `__Host-csrf` cookie encrypted under
 * a secret nuxt-csurf generates AT BUILD TIME, so the first `web` image an
 * in-app update promotes invalidates the token every open tab is holding — and
 * an `ssr:false` SPA renders one document per tab and never re-mints it. What
 * the tab saw was a bare 403 on every POST from then on, surfaced by each
 * caller as its own unrelated failure.
 *
 * Returns false when the refresh brought nothing new, which is what keeps a
 * genuine rejection (no cookie at all, CSRF disabled server-side, the endpoint
 * itself refusing) from turning into a retry loop.
 */
async function fetchCsrfToken(): Promise<boolean> {
	const previous = readCsrfToken(window.document);
	let token: unknown;
	try {
		({ token } = (await nuxtFetch()('/api/csrf-token', {
			method: 'GET',
			retry: 0,
		})) as { token?: unknown });
	} catch {
		return false;
	}
	if (typeof token !== 'string' || !token || token === previous) return false;
	writeCsrfToken(window.document, token);
	return true;
}

/**
 * Whether a failed request failed at the CSRF middleware — which rejects
 * BEFORE any route handler runs, so the retry below can never re-execute a
 * side effect the first attempt already had.
 */
function isStaleTokenFailure(err: unknown, request: string, options?: FetchOptions): boolean {
	if ((err as { status?: unknown } | null)?.status !== 403) return false;
	if (!isCsrfRejection((err as { data?: unknown }).data)) return false;
	// Only requests we put a token on can fail for want of a fresh one.
	return shouldAttachCsrfToken({
		request,
		method: options?.method,
		baseURL: options?.baseURL,
		href: window.location.href,
	});
}

/**
 * Run a decorated request, and on a CSRF rejection mint a fresh token and run
 * it once more. One retry, gated on the refresh actually producing a new
 * token, so a server that is rejecting for any other reason still surfaces its
 * 403 to the caller.
 */
async function withStaleTokenRetry<T>(
	request: string,
	options: FetchOptions | undefined,
	send: (options: FetchOptions) => Promise<T>
): Promise<T> {
	try {
		return await send(decorate(request, options));
	} catch (err) {
		if (!isStaleTokenFailure(err, request, options)) throw err;
		if (!(await refreshCsrfToken())) throw err;
		return await send(decorate(request, options));
	}
}

export const apiFetch: ApiFetch = Object.assign(
	<T = unknown>(request: string, options?: FetchOptions): Promise<T> =>
		withStaleTokenRetry(
			request,
			options,
			(decorated) => nuxtFetch()(request, decorated) as Promise<T>
		),
	{
		raw: <T = unknown>(request: string, options?: FetchOptions): Promise<FetchResponse<T>> =>
			withStaleTokenRetry(
				request,
				options,
				(decorated) => nuxtFetch().raw(request, decorated) as Promise<FetchResponse<T>>
			),
	}
);
