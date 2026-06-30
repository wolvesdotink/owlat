/**
 * DMARC identifier alignment — shared between the Convex backend (sending-domain
 * DNS generation / verification) and the MTA (envelope construction), so both
 * agree on what "aligned" means instead of forking the rule.
 *
 * DMARC (RFC 7489 §3.1) passes when at least one of SPF or DKIM both
 * authenticates AND *aligns* with the RFC5322.From domain. SPF authenticates
 * the envelope MAIL FROM (the return-path) domain, so SPF can only contribute to
 * DMARC when the return-path domain aligns with the From-domain:
 *
 *  - `strict`: the two domains are identical.
 *  - `relaxed` (DMARC's default `aspf=r`): they share the same Organizational
 *    Domain, so a return-path subdomain (`bounce.acme.com`) aligns with
 *    `acme.com`.
 *
 * The Owlat MTA's VERP envelope uses a single shared bounce domain
 * (`bounce+…@RETURN_PATH_DOMAIN`, e.g. `bounces.owlat.com`), which does NOT
 * align with a customer From-domain (`acme.com`) under either mode — so on the
 * shared-bounce-domain path SPF cannot satisfy DMARC and DKIM alignment carries
 * it. A per-customer return-path subdomain makes SPF align too.
 */

export type AlignmentMode = 'strict' | 'relaxed';

/** Lowercase + strip a single trailing dot for comparison. */
function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Organizational-Domain approximation used for `relaxed` alignment: the last
 * two labels. Deliberately simple — it does NOT consult the Public Suffix List,
 * so multi-label public suffixes (e.g. `co.uk`) are not special-cased. This is
 * sufficient for the single-deployment self-host model where the return-path and
 * From-domain share a parent domain.
 */
function organizationalDomain(domain: string): string {
	const labels = normalizeDomain(domain).split('.').filter(Boolean);
	if (labels.length <= 2) return labels.join('.');
	return labels.slice(-2).join('.');
}

/**
 * DMARC SPF alignment: does the SPF-authenticated identity (the envelope
 * MAIL FROM / return-path domain) align with the RFC5322.From domain?
 */
export function isSpfAligned(
	envelopeFromDomain: string,
	fromDomain: string,
	mode: AlignmentMode = 'relaxed',
): boolean {
	const envelope = normalizeDomain(envelopeFromDomain);
	const from = normalizeDomain(fromDomain);
	if (!envelope || !from) return false;
	if (mode === 'strict') return envelope === from;
	return organizationalDomain(envelope) === organizationalDomain(from);
}

/**
 * Extract the domain part of an email address (after the last `@`), lowercased.
 * Handles VERP / plus-addressed local parts (`bounce+abc@host` → `host`).
 */
export function emailDomain(address: string): string {
	const at = address.lastIndexOf('@');
	if (at === -1) return '';
	return normalizeDomain(address.slice(at + 1));
}
