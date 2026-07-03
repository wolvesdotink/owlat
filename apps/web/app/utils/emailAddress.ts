/**
 * Shared address-string helpers for the Postbox client.
 */

/**
 * Extract the bare address from a `"Name <addr>"` header value, trimmed and
 * lowercased for dedupe/exclusion/lookup compares. A value without angle
 * brackets is returned as-is (trimmed + lowercased).
 */
export function extractEmailAddress(raw: string): string {
	const angled = raw.match(/<([^>]+)>/);
	return (angled?.[1] ?? raw).trim().toLowerCase();
}
