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
 *   the autocapture element chain) gets the same treatment.
 * - Events captured while the page is one of `PRIVATE_ROUTE_NAMES` are dropped
 *   whole: those pages exist to handle a credential, and there is nothing on
 *   them worth measuring that would justify the risk.
 */

/**
 * Pages whose URL carries a credential (a token in the query, an OAuth `code`,
 * a handshake nonce or an invitation id). Nuxt route names: the i18n strategy is `no_prefix`, so
 * a name is stable across locales.
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
const ABSOLUTE_URL = /\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>()\\]*/gi;
/** A path at the start of a token: after whitespace, a quote, `(` or `=`. */
const RELATIVE_PATH = /(^|[\s"'(=,])(\/(?!\/)[^\s"'<>()\\]*)/g;

function sanitizeText(text: string, context: AnalyticsUrlContext): string {
	return text
		.replace(CHAIN_HREF, (_m, head: string, value: string) => {
			return `${head}${sanitizeAnalyticsUrl(value.replace(/\\"/g, '"'), context)}"`;
		})
		.replace(ABSOLUTE_URL, (match) => sanitizeAnalyticsUrl(match, context))
		.replace(RELATIVE_PATH, (_m, lead: string, path: string) => {
			return lead + sanitizeAnalyticsUrl(path, context);
		});
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
