/**
 * Pure helpers for validating the "Default From Email" against the org's
 * verified sending domains (settings/index.vue). Surfacing the mismatch as a
 * non-blocking warning — rather than a hard error — keeps the field usable
 * while a domain is still being verified, but points the operator at
 * /dashboard/settings/domains before they ship campaigns from an unauthorized
 * domain.
 */

/** Extract the lowercased domain portion of an email address, or null. */
export function emailDomain(email: string): string | null {
	const at = email.lastIndexOf('@');
	if (at < 0) return null;
	const domain = email.slice(at + 1).trim().toLowerCase();
	return domain.length > 0 ? domain : null;
}

/**
 * Warning text when a From email's domain is not among the verified sending
 * domains, or null when there is nothing to warn about. Returns null when:
 *   - the email is empty or has no domain part,
 *   - the verified-domain set is still loading (`undefined`/`null`) — never nag
 *     before the data arrives,
 *   - the domain IS verified.
 * Matching is case-insensitive.
 */
export function unverifiedFromDomainWarning(
	email: string,
	verifiedDomains: string[] | undefined | null,
): string | null {
	const domain = emailDomain(email);
	if (!domain) return null;
	if (!verifiedDomains) return null;
	const verified = new Set(verifiedDomains.map((d) => d.toLowerCase()));
	if (verified.has(domain)) return null;
	return `${domain} is not a verified sending domain.`;
}
