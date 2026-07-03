/**
 * Pure recipient-field helpers for the Postbox composer:
 *   - external-domain detection (is a recipient outside the user's own
 *     domain(s), treating subdomains as internal), and
 *   - reply-all-gap derivation (who a plain Reply leaves out versus Reply-All).
 *
 * Kept framework-free so the composer logic is unit-testable in isolation.
 */

/** Strip "Name <addr>" framing and lowercase, for compares. */
export function canonicalEmailAddress(raw: string): string {
	const m = raw.match(/<([^>]+)>/);
	return (m?.[1] ?? raw).trim().toLowerCase();
}

/** Lowercased domain part of an email, or null if it has none. */
export function emailDomain(raw: string): string | null {
	const canon = canonicalEmailAddress(raw);
	const at = canon.lastIndexOf('@');
	if (at < 0) return null;
	const domain = canon.slice(at + 1);
	return domain.length > 0 ? domain : null;
}

/** True when `candidate` is the same domain as `own` or a subdomain of it. */
function domainIsInternal(candidate: string, own: string): boolean {
	return candidate === own || candidate.endsWith(`.${own}`);
}

/**
 * Whether `email` is outside every one of the user's own domains. Subdomains of
 * an own domain count as internal. Returns false (not external) when we can't
 * tell — no own domains known, or the address has no parseable domain — so the
 * cue only ever appears when we're confident.
 */
export function isExternalRecipient(email: string, ownDomains: readonly string[]): boolean {
	if (ownDomains.length === 0) return false;
	const domain = emailDomain(email);
	if (!domain) return false;
	const owned = ownDomains
		.map((d) => d.trim().toLowerCase())
		.filter((d) => d.length > 0);
	if (owned.length === 0) return false;
	return !owned.some((own) => domainIsInternal(domain, own));
}

/** Derive the set of own email domains from the mailbox's identity addresses. */
export function ownDomainsFromIdentities(identities: readonly string[]): string[] {
	const set = new Set<string>();
	for (const id of identities) {
		const d = emailDomain(id);
		if (d) set.add(d);
	}
	return [...set];
}

export interface ReplyAllSource {
	fromAddress: string;
	toAddresses: string[];
	ccAddresses: string[];
}

/**
 * The recipients a Reply-All would add beyond a plain Reply: every To/Cc
 * participant of the original message that isn't the sender (already in To on a
 * reply) and isn't one of the user's own addresses. Order preserved, deduped by
 * canonical address. Raw address strings are returned so display framing (a
 * "Name <addr>") survives into the draft.
 */
export function deriveReplyAllExtras(
	source: ReplyAllSource,
	selfAddresses: readonly string[]
): string[] {
	const seen = new Set<string>([
		canonicalEmailAddress(source.fromAddress),
		...selfAddresses.map(canonicalEmailAddress),
	]);
	const extras: string[] = [];
	for (const addr of [...source.toAddresses, ...source.ccAddresses]) {
		const canon = canonicalEmailAddress(addr);
		if (!canon || seen.has(canon)) continue;
		seen.add(canon);
		extras.push(addr);
	}
	return extras;
}

/** Best display label for a recipient chip/hint: the name, else the local part. */
export function recipientLabel(raw: string): string {
	const named = raw.match(/^\s*"?([^"<]+?)"?\s*</);
	if (named?.[1]) return named[1].trim();
	const canon = canonicalEmailAddress(raw);
	const at = canon.indexOf('@');
	return at > 0 ? canon.slice(0, at) : canon;
}
