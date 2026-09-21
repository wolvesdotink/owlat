/**
 * True when `path` normalises to a dot-dot traversal.
 *
 * The `/api/auth/[...]` proxy concatenates `event.path` onto the Convex site
 * URL and hands it to `new URL()`, which resolves `/api/auth/../../foo` up out
 * of the auth namespace — a caller could otherwise reach arbitrary Convex HTTP
 * routes through the proxy. We decode repeatedly (bounded) so a multiply-encoded
 * `%252e%252e` cannot slip a `..` past the check, treat both `/` and `\` as
 * separators, and reject on any decode error (malformed percent-encoding is
 * never a legitimate BetterAuth path). Pure + separate from the route module so
 * the rule is unit-testable without the h3/Nuxt request runtime.
 */
export function authPathHasTraversal(path: string): boolean {
	let decoded = path;
	for (let i = 0; i < 3; i++) {
		let next: string;
		try {
			next = decodeURIComponent(decoded);
		} catch {
			return true;
		}
		if (next === decoded) break;
		decoded = next;
	}
	return /(^|[/\\])\.\.([/\\]|$)/.test(decoded);
}
