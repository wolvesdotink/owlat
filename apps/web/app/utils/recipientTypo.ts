/**
 * Did-you-mean for a recipient domain (composer, on chip commit).
 *
 * `marcel@gmial.com` is a syntactically valid address that sends without a
 * murmur, and a misdirected email is unrecoverable — it is a privacy exposure,
 * not a typo. The inbound side of the product already asks the mirror-image
 * question ("is this From domain a near-miss of a domain a contact uses?"), so
 * this reuses the same bounded edit distance from `@owlat/shared` rather than
 * inventing a second notion of "close".
 *
 * Two candidate sets, in priority order:
 *   1. the domains the user actually writes to (contact frecency), because
 *      `@northwind.studio` matters more to this user than any global list;
 *   2. a short list of consumer providers, which is where the classic slips
 *      (`gmial`, `hotmial`, `yaho`) happen and which a new user's empty address
 *      book cannot supply.
 *
 * Advisory by construction: the caller renders an inline hint with a one-click
 * fix and NEVER blocks the send. An exact match against either set is silent —
 * the whole point is to catch the near-miss, not to nag about correct mail.
 */

import { boundedEditDistance, extractDomainOrNull, LOOKALIKE_MAX_EDITS } from '@owlat/shared';
import { canonicalEmailAddress } from '~/utils/recipientHints';

/**
 * Consumer mailbox providers, as a floor under the user's own contact domains.
 * Deliberately short: every entry is a domain a typo can plausibly land near,
 * and a longer list only buys more chances to suggest the wrong correction.
 */
export const COMMON_MAIL_DOMAINS: readonly string[] = [
	'aol.com',
	'fastmail.com',
	'gmail.com',
	'gmx.de',
	'gmx.net',
	'googlemail.com',
	'hotmail.com',
	'icloud.com',
	'live.com',
	'mail.com',
	'me.com',
	'outlook.com',
	'posteo.de',
	'proton.me',
	'protonmail.com',
	't-online.de',
	'web.de',
	'yahoo.com',
	'yandex.com',
	'zoho.com',
];

export interface DomainSuggestion {
	/** The canonical address as typed — the chip this suggestion is about. */
	mistyped: string;
	/** The domain as typed. */
	typed: string;
	/** The domain we believe was meant. */
	suggested: string;
	/** The full corrected address, ready to replace the chip. */
	address: string;
}

/**
 * A short domain has no room for two slips without becoming a different domain
 * altogether (`web.de` and `gmx.de` are three edits apart but both real), so the
 * bound tightens as the domain gets shorter.
 */
function maxEditsFor(domain: string): number {
	return domain.length <= 7 ? 1 : LOOKALIKE_MAX_EDITS;
}

/**
 * The domain `address` most likely meant, or null when it is already right (an
 * exact hit in either candidate set), too far from everything to guess, or not
 * parseable as an address at all.
 */
export function suggestRecipientDomain(
	address: string,
	knownDomains: readonly string[] = []
): DomainSuggestion | null {
	const canonical = canonicalEmailAddress(address);
	const typed = extractDomainOrNull(canonical);
	if (!typed || !typed.includes('.')) return null;

	const known = knownDomains.map((d) => d.trim().toLowerCase()).filter((d) => d.includes('.'));
	// Known domains first so a user's own `acme-corp.io` outranks a global entry.
	const candidates = [...known, ...COMMON_MAIL_DOMAINS];
	if (candidates.includes(typed)) return null;

	const max = maxEditsFor(typed);
	let best: { domain: string; distance: number } | null = null;
	for (const candidate of candidates) {
		const distance = boundedEditDistance(typed, candidate, max);
		if (distance < 1 || distance > max) continue;
		if (!best || distance < best.distance) best = { domain: candidate, distance };
		if (best.distance === 1) break;
	}
	if (!best) return null;

	const localPart = canonical.slice(0, canonical.lastIndexOf('@'));
	if (!localPart) return null;
	return {
		mistyped: canonical,
		typed,
		suggested: best.domain,
		address: `${localPart}@${best.domain}`,
	};
}
