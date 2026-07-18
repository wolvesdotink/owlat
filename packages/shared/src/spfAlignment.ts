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
 * Second-level labels that act as public suffixes under a two-letter country
 * TLD, so `victim.co.uk` is the registrable domain (not `co.uk`). A curated
 * embedded set — matching `email-scanner`'s `senderImpersonation` convention —
 * rather than a full Public Suffix List dependency: it covers the common
 * `co.uk` / `com.au` / `org.uk` / `co.jp` style suffixes that would otherwise
 * fold distinct organisations together. Missing an exotic suffix errs toward
 * over-folding, so extend deliberately; a full PSL remains a future option.
 */
const SECOND_LEVEL_PUBLIC_SUFFIXES = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu']);

/**
 * Organizational-Domain approximation used for `relaxed` alignment (RFC 7489
 * §3.2). A curated eTLD+1 heuristic that does NOT vendor the full Public Suffix
 * List: when the last label is a two-letter ccTLD and the second-to-last is a
 * known public second-level suffix (`co`, `com`, …), it keeps the last THREE
 * labels so distinct orgs on the same ccTLD stay distinct (`attacker.co.uk` ≠
 * `victim.co.uk`); otherwise it keeps the last two. This closes the co.uk-class
 * relaxed-alignment bypass (where a full PSL is not vendored) — matching the
 * `senderImpersonation.registrableDomain` pattern. A full PSL remains a future
 * option.
 */
export function organizationalDomain(domain: string): string {
	const labels = normalizeDomain(domain).split('.').filter(Boolean);
	if (labels.length <= 2) return labels.join('.');
	const tld = labels[labels.length - 1]!;
	const sld = labels[labels.length - 2]!;
	const keep = tld.length === 2 && SECOND_LEVEL_PUBLIC_SUFFIXES.has(sld) ? 3 : 2;
	return labels.slice(-keep).join('.');
}

/**
 * DMARC SPF alignment: does the SPF-authenticated identity (the envelope
 * MAIL FROM / return-path domain) align with the RFC5322.From domain?
 */
export function isSpfAligned(
	envelopeFromDomain: string,
	fromDomain: string,
	mode: AlignmentMode = 'relaxed'
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
