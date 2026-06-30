/**
 * Validate a `redirect` / `redirectTo` value before navigating to it.
 *
 * Open-redirect defense: only same-origin paths are allowed through.
 * Anything else (scheme, protocol-relative, backslash-tricks, control
 * chars) is rejected in favour of the supplied fallback.
 *
 * Accepted shapes (all stay on the current origin):
 *   - "/dashboard"
 *   - "/inbox?folder=archived#top"
 *
 * Rejected shapes:
 *   - "https://evil.com"
 *   - "//evil.com"
 *   - "/\\evil.com"
 *   - "javascript:alert(1)"
 *   - " /dashboard" (leading whitespace — could be control-char smuggling)
 *   - "" / null / undefined / non-strings
 */
export function safeRedirect(value: unknown, fallback: string): string {
	if (typeof value !== 'string' || value.length === 0) return fallback;

	// Reject any control characters or whitespace anywhere in the value.
	// Browsers / Nuxt navigateTo handle whitespace-stripping inconsistently and
	// a leading "\t" or "\r" can let "//evil.com" sneak through some checks.
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x20\x7F]/.test(value)) return fallback;

	// Must start with a single forward slash …
	if (value[0] !== '/') return fallback;

	// … but NOT "//" or "/\\" (protocol-relative URLs / Windows path tricks).
	if (value[1] === '/' || value[1] === '\\') return fallback;

	// Reject any scheme-like substring even after the slash. A safe relative
	// path won't contain ":" at all before the first "?" or "#".
	const stopAt = value.search(/[?#]/);
	const pathPart = stopAt === -1 ? value : value.slice(0, stopAt);
	if (pathPart.includes(':')) return fallback;

	return value;
}
