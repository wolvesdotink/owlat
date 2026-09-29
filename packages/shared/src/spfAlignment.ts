/**
 * DMARC identifier alignment — shared between the Convex backend (sending-domain
 * DNS generation / verification), the MTA (envelope construction and the
 * outbound DKIM-alignment gate) and `@owlat/mail-auth` (inbound DMARC and ARC),
 * so all of them agree on what "aligned" means instead of forking the rule.
 *
 * DMARC (RFC 7489 §3.1) passes when at least one of SPF or DKIM both
 * authenticates AND *aligns* with the RFC5322.From domain. The same rule serves
 * both authenticated identities: the SPF identity is the envelope MAIL FROM
 * (return-path) domain, the DKIM identity is the signature's `d=` domain.
 * `isIdentifierAligned` is the neutral predicate; `isSpfAligned` is a thin
 * wrapper kept for the SPF call sites.
 *
 *  - `strict` (`aspf=s` / `adkim=s`): the two domains are identical.
 *  - `relaxed` (DMARC's default): they share the same Organizational Domain,
 *    so a subdomain (`bounce.acme.com`, `mail.acme.com`) aligns with
 *    `acme.com` and with sibling subdomains such as `news.acme.com`.
 *
 * The Owlat MTA's VERP envelope uses a single shared bounce domain
 * (`bounce+…@RETURN_PATH_DOMAIN`, e.g. `bounces.owlat.com`), which does NOT
 * align with a customer From-domain (`acme.com`) under either mode — so on the
 * shared-bounce-domain path SPF cannot satisfy DMARC and DKIM alignment carries
 * it. A per-customer return-path subdomain makes SPF align too.
 */

import { getDomain } from 'tldts';
import { normalizeDomain } from './utils/normalizeDomain';

export type AlignmentMode = 'strict' | 'relaxed';

/**
 * Organizational Domain used for relaxed alignment (RFC 7489 §3.2): the
 * registrable eTLD+1 from the Public Suffix List. Private suffixes are enabled
 * because independently controlled tenants beneath entries such as `uk.com`
 * or `github.io` must never authenticate one another. If the PSL cannot derive
 * an eTLD+1 (single-label/internal or malformed input), fall back to the exact
 * normalized domain; exact comparison is the fail-closed alignment behavior.
 */
export function organizationalDomain(domain: string): string {
	const normalized = normalizeDomain(domain);
	if (!normalized) return '';
	return getDomain(normalized, { allowPrivateDomains: true }) ?? normalized;
}

/**
 * DMARC identifier alignment (RFC 7489 §3.1): does an authenticated identity
 * domain (SPF's envelope MAIL FROM domain, or DKIM's `d=` domain) align with
 * the RFC5322.From domain under the given mode?
 */
export function isIdentifierAligned(
	identityDomain: string,
	fromDomain: string,
	mode: AlignmentMode = 'relaxed'
): boolean {
	const identity = normalizeDomain(identityDomain);
	const from = normalizeDomain(fromDomain);
	if (!identity || !from) return false;
	if (mode === 'strict') return identity === from;
	return organizationalDomain(identity) === organizationalDomain(from);
}

/**
 * DMARC SPF alignment: {@link isIdentifierAligned} applied to the
 * SPF-authenticated identity (the envelope MAIL FROM / return-path domain).
 * A thin wrapper, so the SPF and DKIM sides can never fork.
 */
export function isSpfAligned(
	envelopeFromDomain: string,
	fromDomain: string,
	mode: AlignmentMode = 'relaxed'
): boolean {
	return isIdentifierAligned(envelopeFromDomain, fromDomain, mode);
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
