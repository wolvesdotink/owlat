/**
 * Pure helpers for validating the "Default From Email" against the org's
 * verified sending domains (instance/general.vue). Surfacing the mismatch as a
 * non-blocking warning — rather than a hard error — lets an operator save the
 * address before DNS is done, while saying that mail from it is refused until
 * the domain verifies, and pointing at /dashboard/admin/delivery/domains.
 */

/** Extract the lowercased domain portion of an email address, or null. */
export function emailDomain(email: string): string | null {
	const at = email.lastIndexOf('@');
	if (at < 0) return null;
	const domain = email
		.slice(at + 1)
		.trim()
		.toLowerCase();
	return domain.length > 0 ? domain : null;
}

/**
 * The From email's domain when it is not among the verified sending domains,
 * or null when there is nothing to warn about. The caller words the warning
 * from it. Returns null when:
 *   - the email is empty or has no domain part,
 *   - the verified-domain set is still loading (`undefined`/`null`) — never nag
 *     before the data arrives,
 *   - the domain IS verified.
 * Matching is case-insensitive.
 */
export function unverifiedFromDomain(
	email: string,
	verifiedDomains: string[] | undefined | null
): string | null {
	const domain = emailDomain(email);
	if (!domain) return null;
	if (!verifiedDomains) return null;
	const verified = new Set(verifiedDomains.map((d) => d.toLowerCase()));
	return verified.has(domain) ? null : domain;
}
