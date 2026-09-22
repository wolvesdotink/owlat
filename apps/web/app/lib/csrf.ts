/**
 * CSRF rules for same-origin, state-changing requests.
 *
 * `security.csrf: true` (nuxt.config.ts) puts nuxt-csurf's middleware in front
 * of every POST/PUT/PATCH that `routeRules` does not exempt. It pairs an
 * httpOnly `__Host-csrf` cookie — set when the SPA shell is rendered — with a
 * `csrf-token` request header, and 403s the request BEFORE the route handler
 * runs when the header is missing.
 *
 * Plain `$fetch` never sends that header: only nuxt-csurf's own `$csrfFetch` /
 * `useCsrfFetch` do, and nothing in this app used them. Every in-app POST to a
 * session-authed route therefore died with a bare 403 that looked like an
 * authorization failure — `/api/system/apply-profiles` ("Apply & restart"),
 * `/api/system/update`, `/api/setup/*` and `/api/delivery/*` alike. Route
 * handler tests never caught it because they import the handler directly and
 * so never run the middleware.
 *
 * `~/lib/csrfFetch` applies these rules; `app/__tests__/noRawApiFetch.test.ts`
 * fails the build if a state-changing call site skips it.
 */

/**
 * The methods nuxt-csurf guards — its `methodsToProtect` default, which this
 * app does not override. Anything else (GET, HEAD, DELETE) passes the
 * middleware untouched and needs no token.
 */
const PROTECTED_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * The `statusMessage` nuxt-csurf puts on its rejection. Callers that read a
 * 403 as a meaningful answer (rather than as a failure) use this to tell the
 * CSRF gate's 403 apart from their endpoint's own.
 */
export const CSRF_REJECTION_STATUS_MESSAGE = 'CSRF Token Mismatch';

/**
 * Whether an error body came from the CSRF middleware rather than from the
 * route behind it. h3 puts `statusMessage` in the JSON body of every error
 * response, so a caller holding a parsed 403 can tell the two apart.
 */
export function isCsrfRejection(body: unknown): boolean {
	return (
		(body as { statusMessage?: unknown } | null)?.statusMessage === CSRF_REJECTION_STATUS_MESSAGE
	);
}

function urlOf(request: unknown): string | null {
	if (typeof request === 'string') return request;
	if (request instanceof URL) return request.href;
	// A `Request` instance — duck-typed, since the constructor is not guaranteed
	// to exist in every runtime this module is loaded in.
	const url = (request as { url?: unknown } | null)?.url;
	return typeof url === 'string' ? url : null;
}

function methodOf(request: unknown, method: string | undefined): string {
	if (method) return method;
	// A `Request` carries its own method, and ofetch leaves it alone when the
	// caller passes no `method` option.
	const own = (request as { method?: unknown } | null)?.method;
	return typeof own === 'string' ? own : 'GET';
}

function resolve(url: string, base: string): URL | null {
	try {
		return new URL(url, base);
	} catch {
		return null;
	}
}

export interface CsrfRequestContext {
	/** ofetch's request argument, before `baseURL` is applied. */
	request: unknown;
	/** The request method, in any casing. Absent falls back to the request's own. */
	method?: string;
	/** ofetch's `baseURL` option, which it prepends to a string request. */
	baseURL?: string;
	/** The page's own URL — `window.location.href`. */
	href: string;
}

/**
 * Whether a request is one the CSRF middleware will demand a token for: a
 * state-changing method aimed at this origin.
 *
 * The origin test is what keeps the token out of third-party requests — a
 * cross-origin request (Convex storage uploads, the Convex site URL, DoH
 * lookups, another instance's `/api/instance-info`) must never carry it.
 *
 * ofetch joins `baseURL` with ufo string helpers rather than with `URL`, so the
 * two resolutions are not identical: ufo does not treat `//host/path` as
 * absolute, so a protocol-relative request under a `baseURL` stays same-origin
 * for ofetch while this returns false. That divergence withholds a token from a
 * request that needed one (a 403 the caller sees), never the reverse — the
 * direction that matters for a rule whose job is to not leak the token.
 *
 * An opaque origin (a `tauri://` page in the desktop shell, say) compares equal
 * to itself as the string `"null"`, so it is excluded explicitly: there is no
 * nuxt-csurf middleware behind a custom scheme to satisfy.
 */
export function shouldAttachCsrfToken({
	request,
	method,
	baseURL,
	href,
}: CsrfRequestContext): boolean {
	if (!PROTECTED_METHODS.has(methodOf(request, method).toUpperCase())) return false;

	const raw = urlOf(request);
	if (raw === null) return false;

	const page = resolve(href, href);
	if (!page || page.origin === 'null') return false;

	const base = baseURL ? resolve(baseURL, href) : page;
	if (!base) return false;

	const target = resolve(raw, base.href);
	return target !== null && target.origin === page.origin;
}

/**
 * The token nuxt-csurf's Nitro plugin renders into the document head, or null
 * when there is none (a prerendered desktop bundle, or a document rendered
 * before the module was enabled).
 *
 * Read from the DOM rather than through nuxt-csurf's `useCsrf()` composable
 * because `useCsrf()` reaches for `useRuntimeConfig()`, which throws outside a
 * Nuxt context — and requests fire from timers and event handlers that have
 * long left it (the setup wizard's restart poller, for one).
 */
export function readCsrfToken(doc: Pick<Document, 'querySelector'>): string | null {
	const content = doc.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
	return content ? content : null;
}

/** The document a refreshed token is written back into. */
export type CsrfTokenDocument = Pick<Document, 'querySelector' | 'createElement' | 'head'>;

/**
 * Write a freshly minted token back into the document head, so every later
 * caller — including ones that left the Nuxt context — reads the live value
 * from the same single place `readCsrfToken` already looks.
 *
 * The tag is created when the document has none: a token can now arrive from
 * `/api/csrf-token` on a document that was rendered before the module was
 * enabled, which is exactly the tab that has no tag to update.
 */
export function writeCsrfToken(doc: CsrfTokenDocument, token: string): void {
	const existing = doc.querySelector('meta[name="csrf-token"]');
	if (existing) {
		existing.setAttribute('content', token);
		return;
	}
	const meta = doc.createElement('meta');
	meta.setAttribute('name', 'csrf-token');
	meta.setAttribute('content', token);
	doc.head.appendChild(meta);
}

/**
 * Return `options` with the CSRF header added, leaving an explicit header set
 * by the caller alone. Headers are normalized to a `Headers` instance, which
 * ofetch accepts and merges as usual.
 */
export function withCsrfHeader<T extends { headers?: HeadersInit }>(
	options: T,
	headerName: string,
	token: string
): T {
	const headers = new Headers(options.headers ?? {});
	if (!headers.has(headerName)) headers.set(headerName, token);
	return { ...options, headers };
}
