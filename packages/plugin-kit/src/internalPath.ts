/**
 * A contributed navigation destination is an internal dashboard path, never an
 * external or scripted URL. The path must be absolute (`/…`), must not be
 * protocol-relative (`//host`), and may only use characters that appear in a
 * static route — no scheme separator, whitespace, or control characters that
 * could smuggle a `javascript:`/`data:` navigation past the leading slash.
 *
 * It must also be canonical: `.`/`..` segments are rejected. A dot-only segment
 * would let a plugin href alias a core destination via a non-canonical path
 * (`/dashboard/audience/contacts/../contacts`) and so dodge the href-based
 * first-registered-wins no-shadow dedup, and `..` would let an href climb
 * outside its apparent area (`/dashboard/../login`).
 *
 * Canonicality also means the exact form the core routes use: lowercase, with
 * no trailing slash. vue-router runs with its lenient defaults here (apps/web
 * declares no router matcher options, so `strict: false`, `sensitive: false`),
 * so `/dashboard/audience/contacts/` and `/DASHBOARD/audience/contacts` would
 * both resolve to the core Contacts route while being different strings from
 * the core href — another way to dodge the href-based no-shadow dedup. Every
 * core destination in `CORE_SECTIONS` is lowercase kebab with no trailing
 * slash, so we require that canonical form (`/dashboard/v1.2/report` still
 * validates — a dot inside an otherwise well-formed segment is fine).
 */
const SAFE_INTERNAL_PATH = /^\/(?:[a-z0-9\-._~]+(?:\/[a-z0-9\-._~]+)*)?$/;
const DOT_ONLY_SEGMENT = /^\.+$/;
const MAX_INTERNAL_PATH_LENGTH = 256;

export function isSafeInternalNavPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_INTERNAL_PATH_LENGTH &&
		!value.startsWith('//') &&
		SAFE_INTERNAL_PATH.test(value) &&
		value.split('/').every((segment) => !DOT_ONLY_SEGMENT.test(segment))
	);
}
