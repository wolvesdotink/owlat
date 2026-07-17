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
 */
const SAFE_INTERNAL_PATH = /^\/(?:[A-Za-z0-9\-._~]+(?:\/[A-Za-z0-9\-._~]+)*\/?)?$/;
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
