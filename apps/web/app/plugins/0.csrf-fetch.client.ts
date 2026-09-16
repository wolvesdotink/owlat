/**
 * CSRF plugin — runs FIRST (the `0.` filename prefix + `enforce: 'pre'`) so the
 * global `$fetch` is already decorated by the time any other plugin, page or
 * composable makes its first request.
 *
 * nuxt-csurf 403s every same-origin POST/PUT/PATCH that arrives without a
 * `csrf-token` header, before the route handler runs. Plain `$fetch` does not
 * send one, so this wraps the global instance and adds it — see `~/lib/csrf`
 * for the whole rationale and for the origin rule that keeps the token off
 * cross-origin requests.
 *
 * Wrapping the instance rather than passing `onRequest` to `$fetch.create()` is
 * deliberate: ofetch resolves per-call options over the instance defaults with
 * a spread, so a single call site passing its own `onRequest` would silently
 * replace the hook and lose the header. `create()` is wrapped too, so an
 * instance derived from the global keeps the behavior.
 */
import type { FetchOptions } from 'ofetch';
import { readCsrfToken, shouldAttachCsrfToken, withCsrfHeader } from '~/lib/csrf';

/**
 * ofetch's runtime shape, without the request/response generics Nitro layers
 * on top of the global `$fetch`. Those generics describe what a call RETURNS;
 * this plugin only ever forwards, so erasing them keeps the wrapper readable
 * and confines the casts to the one assignment at the bottom.
 */
interface FetchInstance {
	(request: unknown, options?: FetchOptions): Promise<unknown>;
	raw(request: unknown, options?: FetchOptions): Promise<unknown>;
	create(defaults?: FetchOptions, globals?: unknown): FetchInstance;
}

export default defineNuxtPlugin({
	name: 'owlat:csrf-fetch',
	enforce: 'pre',
	setup() {
		const { headerName } = useCsrf();
		// No configured header name means the module is disabled; leave `$fetch`
		// exactly as it was rather than stamping a header nothing reads.
		if (!headerName) return;

		function decorate(request: unknown, options?: FetchOptions): FetchOptions {
			const resolved = options ?? {};
			if (
				!shouldAttachCsrfToken({
					request: request as string,
					method: resolved.method,
					baseURL: resolved.baseURL,
					href: window.location.href,
				})
			) {
				return resolved;
			}
			// Read per request: the token is only in the document once the SPA
			// shell has been rendered by the server, and a caller may outlive it.
			const token = readCsrfToken(window.document);
			return token ? withCsrfHeader(resolved, headerName, token) : resolved;
		}

		function wrapInstance(instance: FetchInstance): FetchInstance {
			const call = (request: unknown, options?: FetchOptions) =>
				instance(request, decorate(request, options));
			// `Object.assign` carries `native` and anything else ofetch hangs off
			// the instance; the third argument re-wraps the two entry points that
			// take options of their own.
			return Object.assign(call, instance, {
				raw: (request: unknown, options?: FetchOptions) =>
					instance.raw(request, decorate(request, options)),
				create: (defaults?: FetchOptions, globals?: unknown) =>
					wrapInstance(instance.create(defaults, globals)),
			});
		}

		globalThis.$fetch = wrapInstance(
			globalThis.$fetch as unknown as FetchInstance
		) as unknown as typeof globalThis.$fetch;
	},
});
