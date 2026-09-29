/**
 * Shared address-string helpers for the Postbox client.
 */

import { normalizeEmail, parseAddress } from '@owlat/shared';

/**
 * Extract the bare address from a `"Name <addr>"` header value, trimmed and
 * lowercased for dedupe/exclusion/lookup compares.
 *
 * Received headers are attacker-controlled, so this goes through the shared
 * RFC 5322 parser (comments, quoted local parts, bounded input) rather than a
 * local regex. A value it cannot parse is returned trimmed and lowercased.
 */
export function extractEmailAddress(raw: string): string {
	return parseAddress(raw)?.address ?? normalizeEmail(raw);
}
