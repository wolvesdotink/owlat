/**
 * A contributed navigation destination is an internal dashboard path, never an
 * external or scripted URL. The path must be absolute (`/…`), must not be
 * protocol-relative (`//host`), and may only use characters that appear in a
 * static route — no scheme separator, whitespace, or control characters that
 * could smuggle a `javascript:`/`data:` navigation past the leading slash.
 */
const SAFE_INTERNAL_PATH = /^\/(?:[A-Za-z0-9\-._~]+(?:\/[A-Za-z0-9\-._~]+)*\/?)?$/;
const MAX_INTERNAL_PATH_LENGTH = 256;

export function isSafeInternalNavPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_INTERNAL_PATH_LENGTH &&
		!value.startsWith('//') &&
		SAFE_INTERNAL_PATH.test(value)
	);
}
