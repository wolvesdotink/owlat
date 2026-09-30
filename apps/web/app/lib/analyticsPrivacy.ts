import type { CaptureResult } from 'posthog-js';

/**
 * What an analytics event may say about where the browser is.
 *
 * `plugins/posthog.client.ts` runs every event through `sanitizeAnalyticsEvent`
 * as PostHog's `before_send`, the last step before anything leaves the
 * browser. The SDK attaches the page location to every capture on its own —
 * `$current_url`, `$pathname`, referrers, the session-entry and person-initial
 * copies of those, the `href` of an autocaptured link — and a query string,
 * fragment or dynamic path segment is where recipient links, password resets
 * and OAuth callbacks carry their one-time values. So the rule is applied to
 * the whole event rather than to the properties this app sets itself:
 *
 * - A URL on this origin becomes its route pattern (`/dashboard/contacts/:id`):
 *   no query, no fragment, no ids.
 * - A URL on another origin becomes that origin alone; a URL without a host
 *   (`mailto:`, `tel:`) becomes its scheme.
 * - Anything URL-shaped inside free text (an exception message, a stack trace,
 *   the autocapture element chain) gets the same treatment: absolute URLs
 *   (including `https:host/…`), network-path URLs (`//host/…`), paths, `www.`
 *   hosts, and the percent-encoded or JSON-escaped forms of these, wherever a
 *   token starts (after a space, quote, bracket, backtick, `;`, `|`, …). A
 *   query or fragment with no URL in front of it is dropped, and the value of a
 *   credential-named parameter (`token=`, `code=`, `state=`, …) is emptied.
 *   Not recognised as URLs (only the value of a credential-named parameter in
 *   them is emptied; the rest of the path, query and fragment stay):
 *   - a scheme-less host without `www.` (`owlat.example/share?x`);
 *   - a URL or path glued to a preceding word or symbol (`see/share?x`,
 *     `_//host/…`, `-//host/…`, `Failed:/share?x`);
 *   - slash-less forms of schemes other than http(s) (`ftp:host`, `wss:/host`);
 *   - double-encoded URLs (`%252F…`) and backslash path separators.
 * - Events captured while the page is one of `PRIVATE_ROUTE_NAMES` are dropped
 *   whole: those pages exist to handle a credential, and there is nothing on
 *   them worth measuring that would justify the risk.
 */

/**
 * Pages whose URL carries a credential (a token in the query, an OAuth `code`,
 * a handshake nonce or an invitation id). Nuxt route names: the i18n strategy
 * is `no_prefix`, so a name is stable across locales.
 */
const PRIVATE_ROUTE_NAMES: ReadonlySet<string> = new Set([
	'auth-reset-password',
	'share',
	'unsubscribe',
	'preferences',
	'confirm',
	'archive',
	'cancel-deletion',
	'oauth-google-callback',
	'desktop-connect',
	'invite-accept',
]);

/** Events whose payload is a page snapshot or keyed by raw URLs; never sent. */
const DROPPED_EVENTS: ReadonlySet<string> = new Set(['$snapshot', '$$heatmap']);

/** Build output: file names only, kept so stack traces stay readable. */
const BUILD_ASSETS_PREFIX = '/_nuxt/';

/** Stand-in path for a same-origin URL that matches no route. */
const UNMATCHED_PATH = '/:unmatched';

export interface ResolvedRoute {
	name: string;
	pattern: string;
}

export interface AnalyticsUrlContext {
	/** The page's own URL, `window.location.href`. */
	base: string;
	/** Route behind a same-origin pathname, or null when none matches. */
	routeOf: (pathname: string) => ResolvedRoute | null;
}

export function isPrivateRouteName(name: unknown): boolean {
	return typeof name === 'string' && PRIVATE_ROUTE_NAMES.has(name);
}

/**
 * A route record's path as a pattern: every parameter as `:name`, custom
 * regexes and modifiers dropped, and an optional segment left out when the
 * location does not fill it.
 */
export function routePattern(recordPath: string, params: Record<string, unknown> = {}): string {
	const segments = recordPath.split('/').flatMap((segment) => {
		const whole = /^:(\w+)(?:\([^/]*\))?([?*+])?$/.exec(segment);
		if (whole) {
			const [, name, modifier] = whole;
			const value = params[name as string];
			const empty =
				value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
			if (empty && (modifier === '?' || modifier === '*')) return [];
		}
		return [segment.replace(/:(\w+)(?:\([^/]*\))?[?*+]?/g, ':$1')];
	});
	return segments.join('/') || '/';
}

function hasScheme(raw: string): boolean {
	return /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//');
}

function originOf(url: URL): string {
	return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}

/**
 * One URL, absolute or relative, reduced to what may be reported. Idempotent:
 * a reduced URL reduces to itself.
 */
export function sanitizeAnalyticsUrl(raw: string, context: AnalyticsUrlContext): string {
	// PostHog's `$direct` marks "no referrer"; it is not a URL.
	if (!raw || raw.startsWith('$')) return raw;
	let url: URL;
	let here: URL;
	try {
		here = new URL(context.base);
		url = new URL(raw, here);
	} catch {
		return raw.replace(/[?#][\s\S]*$/, '');
	}
	if (!url.host) return url.protocol;
	const origin = originOf(url);
	if (origin !== originOf(here)) return origin;
	const path = url.pathname.startsWith(BUILD_ASSETS_PREFIX)
		? url.pathname
		: (context.routeOf(url.pathname)?.pattern ?? UNMATCHED_PATH);
	return hasScheme(raw) ? origin + path : path;
}

/** Properties that hold a single URL or path, whatever it looks like. */
const URL_KEY = /(?:url|href|referrer|pathname|^attr__(?:src|srcset|action|formaction))$/i;
/** `href="…"` inside `$elements_chain`, where values are quote-escaped. */
const CHAIN_HREF = /((?:^|[:";])(?:attr__)?href=")((?:\\.|[^"\\])*)"/g;
/**
 * How far a URL runs inside text: up to whitespace, a quote, or a bracket,
 * brace, backtick or pipe that a message might wrap it in.
 */
const URL_BODY = String.raw`[^\s"'<>()[\]{}${'`'}|\\]*`;
/** A bracketed IPv6 host, the one place a URL legitimately holds `[`. */
const IPV6_HOST = String.raw`(?:\[[\da-f:.]+\])?`;
/**
 * Not glued to a preceding word, scheme, path or escape: a path or URL starts
 * at the beginning of a token, whatever punctuation wraps it. Also keeps the
 * `//` of an already reduced absolute URL (after `:`) from matching again, and
 * leaves arithmetic and aliases alone (`(a)/(b)`, `+/-`, `5€/month`,
 * `~/components`, `@/components`).
 */
const TOKEN_START = String.raw`(?<![\w:/.%\\)\]}~@+*!€$£¥-])`;
/**
 * An absolute URL, plus the slash-less `https:host/…` forms browsers accept.
 * The scheme is bounded and may not continue a longer run of scheme
 * characters: an unbounded scheme makes a failed match rescan to the end of
 * the text from every word boundary.
 */
const ABSOLUTE_URL = new RegExp(
	String.raw`(?<![a-z\d+.-])(?:[a-z][a-z\d+.-]{0,31}(?::|%3A)\/\/|https?:\/?(?=[a-z\d[]))` +
		IPV6_HOST +
		URL_BODY,
	'gi'
);
/**
 * The same, or a path or network-path URL, percent-encoded (`https%3A%2F%2F…`,
 * `%2F%2Fhost%2F…`, `%2Fshare%3F…`), as found in quoted redirect targets.
 * Stops at `&`, which an encoded value cannot contain unencoded.
 */
const ENCODED_URL = new RegExp(
	String.raw`(?<![\w%.+-])(?:[a-z][a-z\d+.-]{0,31}%3A)?%2F[^\s"'<>()[\]{}${'`'}|\\&]*`,
	'gi'
);
/** A path (`/…`, `./…`, `../…`) or a network-path URL (`//host/…`) at the start of a token. */
const RELATIVE_PATH = new RegExp(
	TOKEN_START + String.raw`(?:\.{1,2}\/|\/(?:\/${IPV6_HOST})?)` + URL_BODY,
	'gi'
);
/** A scheme-less host that still reads as a link. */
const WWW_HOST = new RegExp(
	TOKEN_START + String.raw`www\.[a-z\d-]+(?:\.[a-z\d-]+)+` + URL_BODY,
	'gi'
);
/** A query or fragment with no URL in front of it (`?token=…`, `#state=…`). */
const DETACHED_QUERY = new RegExp(TOKEN_START + String.raw`[?#][\w.-]+=` + URL_BODY, 'g');
/** A credential-named parameter anywhere in text, as `name=value` (quoted values are not). */
const CREDENTIAL_PARAM =
	/(^|[\s?&#;,"'(<[{`|])((?:access_|id_|refresh_)?token|code|state|secret|password|signature|sig|ott|otp|api_?key)=[^\s&#"'<>()[\]{}`|\\;,]+/gi;

/**
 * `https:host/…` and `https:/host/…` as browsers read them (`https://host/…`),
 * and a scheme whose colon alone is encoded (`https%3A//host/…`). Parsed as
 * written, the slash-less forms would resolve against the page itself.
 */
function withFullScheme(url: string): string {
	return url.replace(/^([a-z][a-z\d+.-]*)%3A/i, '$1:').replace(/^(https?):\/?(?!\/)/i, '$1://');
}

function decoded(encoded: string): string {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded.replace(/%3F[\s\S]*$|%23[\s\S]*$/i, '');
	}
}

function sanitizeText(text: string, context: AnalyticsUrlContext): string {
	return (
		text
			.replace(CHAIN_HREF, (_m, head: string, value: string) => {
				return `${head}${sanitizeAnalyticsUrl(value.replace(/\\"/g, '"'), context)}"`;
			})
			// JSON-escaped slashes (`https:\/\/…`, or escaped twice) read as plain ones.
			.replace(/(?<!\\)\\+\//g, '/')
			.replace(ENCODED_URL, (match) => sanitizeAnalyticsUrl(decoded(match), context))
			.replace(ABSOLUTE_URL, (match) => sanitizeAnalyticsUrl(withFullScheme(match), context))
			.replace(RELATIVE_PATH, (match) => sanitizeAnalyticsUrl(match, context))
			.replace(WWW_HOST, (match) => sanitizeAnalyticsUrl(`//${match}`, context))
			.replace(DETACHED_QUERY, '')
			.replace(CREDENTIAL_PARAM, (_m, lead: string, name: string) => `${lead}${name}=`)
	);
}

/**
 * Guards against a pathological (or cyclic) payload; real ones are shallow.
 * Anything nested deeper is dropped rather than sent unread.
 */
const MAX_DEPTH = 12;

function sanitizeValue(
	value: unknown,
	key: string,
	context: AnalyticsUrlContext,
	depth: number
): unknown {
	if (typeof value === 'string') {
		return URL_KEY.test(key) ? sanitizeAnalyticsUrl(value, context) : sanitizeText(value, context);
	}
	if (value === null || typeof value !== 'object') return value;
	if (depth >= MAX_DEPTH) return null;
	if (Array.isArray(value)) {
		return value.map((item): unknown => sanitizeValue(item, key, context, depth + 1));
	}
	// Serialised the way the SDK will serialise it: a `URL` or a `Date` by its
	// `toJSON`, anything else by its own enumerable properties.
	const toJSON = (value as { toJSON?: unknown }).toJSON;
	if (typeof toJSON === 'function') {
		return sanitizeValue(toJSON.call(value), key, context, depth + 1);
	}
	return sanitizeRecord(value as Record<string, unknown>, context, depth + 1);
}

function sanitizeRecord(
	record: Record<string, unknown>,
	context: AnalyticsUrlContext,
	depth = 0
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		out[sanitizeText(key, context)] = sanitizeValue(value, key, context, depth);
	}
	return out;
}

/** PostHog `before_send`: the event with every URL reduced, or null to drop it. */
export function sanitizeAnalyticsEvent(
	event: CaptureResult | null,
	context: AnalyticsUrlContext
): CaptureResult | null {
	if (!event || DROPPED_EVENTS.has(event.event)) return null;
	let pathname: string;
	try {
		pathname = new URL(context.base).pathname;
	} catch {
		return null;
	}
	if (isPrivateRouteName(context.routeOf(pathname)?.name)) return null;
	// A sample taken on a private page and sent after leaving it.
	if (isPrivateRouteName(event.properties?.['route'])) return null;

	const sanitized: CaptureResult = {
		...event,
		properties: sanitizeRecord(event.properties ?? {}, context),
	};
	if (event.$set) sanitized.$set = sanitizeRecord(event.$set, context);
	if (event.$set_once) sanitized.$set_once = sanitizeRecord(event.$set_once, context);
	return sanitized;
}
