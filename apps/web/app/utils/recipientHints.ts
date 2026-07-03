/**
 * Pure recipient-field helpers for the Postbox composer:
 *   - external-domain detection (is a recipient outside the user's own
 *     domain(s), treating subdomains as internal),
 *   - reply-all-gap derivation (who a plain Reply leaves out vs Reply-All), and
 *   - canonical-deduped recipient merging (fold reply-all extras into Cc).
 *
 * Address parsing (name/address/domain extraction, canonicalization) is
 * delegated to the shared, better-tested RFC-5322-ish parser in `@owlat/shared`
 * rather than re-implemented here — only the genuinely new domain-membership and
 * reply-all logic lives in this module. Kept framework-free so it's unit-testable
 * in isolation.
 */
import { extractDomainOrNull, normalizeEmail, parseAddress } from '@owlat/shared';

/**
 * Canonical lookup key for a recipient string: the parsed `local@domain`,
 * lowercased. Strips any `"Name" <addr>` framing. Falls back to a trimmed,
 * lowercased form when no address can be parsed so dedup still has a stable key.
 */
export function canonicalEmailAddress(raw: string): string {
	return parseAddress(raw)?.address ?? normalizeEmail(raw);
}

/** Lowercased domain part of a recipient string, or null if it has none. */
export function emailDomain(raw: string): string | null {
	return extractDomainOrNull(raw);
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
	return mergeRecipients([], [...source.toAddresses, ...source.ccAddresses], [
		source.fromAddress,
		...selfAddresses,
	]);
}

/**
 * Append `additions` to `existing`, skipping any address already present in
 * `existing` or in `exclude` (all compared by canonical key). Order is
 * preserved and existing entries are kept first. Raw address strings survive so
 * display framing is not lost. This is the single canonical-dedup merge behind
 * both reply-all derivation and folding extras into Cc.
 */
export function mergeRecipients(
	existing: readonly string[],
	additions: readonly string[],
	exclude: readonly string[] = []
): string[] {
	const seen = new Set<string>(
		[...existing, ...exclude].map(canonicalEmailAddress)
	);
	const merged = [...existing];
	for (const addr of additions) {
		const canon = canonicalEmailAddress(addr);
		if (!canon || seen.has(canon)) continue;
		seen.add(canon);
		merged.push(addr);
	}
	return merged;
}

/** Best display label for a recipient chip/hint: the name, else the local part. */
export function recipientLabel(raw: string): string {
	const parsed = parseAddress(raw);
	if (parsed?.name) return parsed.name;
	const address = parsed?.address ?? normalizeEmail(raw);
	const at = address.indexOf('@');
	return at > 0 ? address.slice(0, at) : address;
}
