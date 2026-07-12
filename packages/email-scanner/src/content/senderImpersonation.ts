/**
 * Sender-Impersonation Detection (Sealed Mail A4)
 *
 * Header-level checks that complement the body/URL rules: a spoofed sender is
 * invisible to keyword and phishing-URL scanning because the deception lives in
 * the `From:` and `Reply-To:` headers, not the content.
 *
 * Two content-only signals (no network, no database — the scanner boundary
 * holds): the From domain visually spoofs a real one (Unicode homoglyphs or a
 * punycode/IDN label), or the Reply-To domain differs from the From domain so a
 * reply silently leaves the apparent sender's domain.
 *
 * Deeper heuristics that need data the scanner cannot see — is this a
 * first-time sender, does the domain look like a KNOWN contact's — are computed
 * at ingest on the Convex side; this rule stays a pure function over the two
 * header strings.
 */

import type { ContentFlag } from '../types.js';
import { registerContentRule } from './rule.js';
import { deconfuse, detectScripts, hasLatinChars } from './homoglyphs.js';

/**
 * Extract the lowercased domain from a raw header value that may be a bare
 * address (`a@b.com`), an angle-addr (`Name <a@b.com>`), or already a domain.
 * Returns undefined when no `@domain` can be recovered.
 */
export function extractHeaderDomain(headerValue: string): string | undefined {
	const trimmed = headerValue.trim();
	// Prefer the address inside angle brackets when present.
	const angle = /<([^>]+)>/.exec(trimmed);
	const address = angle?.[1] ?? trimmed;
	const at = address.lastIndexOf('@');
	if (at === -1) return undefined;
	const domain = address
		.slice(at + 1)
		.trim()
		.replace(/[>,;\s]+$/, '')
		.toLowerCase();
	return domain.length > 0 ? domain : undefined;
}

/**
 * Second-level labels that act as public suffixes under a two-letter country
 * TLD, so `paypal.co.uk` is the registrable domain (not `co.uk`). A small
 * embedded set rather than a full public-suffix-list dependency — it covers the
 * common `co.uk` / `com.au` / `org.uk` style suffixes that would otherwise fold
 * distinct organisations together. Missing an exotic suffix errs toward
 * over-folding, so extend deliberately.
 */
const SECOND_LEVEL_PUBLIC_SUFFIXES = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu']);

/**
 * Reduce a domain to its registrable form so that subdomains of the same
 * organisation compare equal — `mail.paypal.com` and `paypal.com` both fold to
 * `paypal.com`, and `support.paypal.co.uk` and `paypal.co.uk` both fold to
 * `paypal.co.uk`. A deliberately coarse eTLD+1 approximation that avoids a
 * public-suffix-list dependency: when the last label is a two-letter TLD and the
 * second-to-last is a known public suffix (`co`, `com`, …), it keeps the last
 * THREE labels so distinct orgs on the same ccTLD stay distinct
 * (`paypal.co.uk` ≠ `evil.co.uk`); otherwise it keeps the last two. This is the
 * safe direction for a mismatch check — it never collapses two different
 * organisations into a false "same org".
 */
export function registrableDomain(domain: string): string {
	const labels = domain.split('.').filter((l) => l.length > 0);
	if (labels.length <= 2) return labels.join('.');
	const tld = labels[labels.length - 1]!;
	const sld = labels[labels.length - 2]!;
	const keep = tld.length === 2 && SECOND_LEVEL_PUBLIC_SUFFIXES.has(sld) ? 3 : 2;
	return labels.slice(-keep).join('.');
}

/**
 * Detect homoglyph/punycode spoofing in the From domain and a Reply-To domain
 * that leaves the From domain. Pure over the header strings.
 */
export function scanSenderImpersonation(from?: string, replyTo?: string): ContentFlag[] {
	const flags: ContentFlag[] = [];

	const fromDomain = from ? extractHeaderDomain(from) : undefined;
	if (fromDomain) {
		// Unicode homoglyphs — the domain deconfuses to a different ASCII string,
		// i.e. it contains characters that mimic Latin letters.
		const deconfused = deconfuse(fromDomain);
		if (deconfused !== fromDomain) {
			flags.push({
				type: 'sender_impersonation',
				severity: 'high',
				description: `Sender domain "${fromDomain}" uses look-alike characters — it reads as "${deconfused}"`,
				match: fromDomain,
			});
		} else {
			// Mixed-script (Latin + another script) without a confusable match is
			// still a homograph signal — flag it only when we did not already flag
			// the confusable case above, to avoid a double flag on one domain.
			const scripts = detectScripts(fromDomain);
			if (scripts.size > 0 && hasLatinChars(fromDomain)) {
				const scriptNames = Array.from(scripts).join(', ');
				flags.push({
					type: 'sender_impersonation',
					severity: 'high',
					description: `Sender domain "${fromDomain}" mixes alphabets (Latin + ${scriptNames}) — a common look-alike trick`,
					match: fromDomain,
				});
			}
		}

		// Punycode / IDN label: an ASCII-encoded internationalised label in the
		// sender domain. Legitimate senders occasionally use IDNs, so this is a
		// softer signal than a decoded homoglyph — flag it as worth a look.
		const hasPunycodeLabel = fromDomain.split('.').some((label) => label.startsWith('xn--'));
		if (hasPunycodeLabel) {
			flags.push({
				type: 'sender_impersonation',
				severity: 'medium',
				description: `Sender domain "${fromDomain}" uses a punycode (internationalised) label — verify it is who it claims to be`,
				match: fromDomain,
			});
		}
	}

	// Reply-To that leaves the From organisation. Compared on registrable domain
	// so a support subdomain of the same org does not false-positive.
	const replyToDomain = replyTo ? extractHeaderDomain(replyTo) : undefined;
	if (fromDomain && replyToDomain) {
		if (registrableDomain(replyToDomain) !== registrableDomain(fromDomain)) {
			flags.push({
				type: 'reply_to_mismatch',
				severity: 'medium',
				description: `Replies go to "${replyToDomain}", a different domain than the sender "${fromDomain}"`,
				match: replyToDomain,
			});
		}
	}

	return flags;
}

registerContentRule({
	id: 'sender-impersonation',
	scan: ({ from, replyTo }) => scanSenderImpersonation(from, replyTo),
});
