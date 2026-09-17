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
 */
import type { FetchOptions, FetchResponse } from 'ofetch';
import { readCsrfToken, shouldAttachCsrfToken, withCsrfHeader } from './csrf';

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

export const apiFetch: ApiFetch = Object.assign(
	<T = unknown>(request: string, options?: FetchOptions): Promise<T> =>
		nuxtFetch()(request, decorate(request, options)) as Promise<T>,
	{
		raw: <T = unknown>(request: string, options?: FetchOptions): Promise<FetchResponse<T>> =>
			nuxtFetch().raw(request, decorate(request, options)) as Promise<FetchResponse<T>>,
	}
);
