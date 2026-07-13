/**
 * ARC trust + DMARC-rescue predicate (Sealed Mail A5), shared between the MTA
 * (which verifies the ARC chain over the raw bytes) and the Convex backend
 * (which owns the operator-editable trusted-forwarder list and applies the
 * override at delivery time). Keeping the decision here means the two sides can
 * never fork on what "a trusted forwarder rescued this message" means.
 *
 * The problem this solves: a mailing list or a forwarding account re-sends a
 * message from its own servers. SPF now authenticates the LIST's return-path
 * and the original author's DKIM signature is often broken by the list's
 * footer/subject rewrites, so plain DMARC (RFC 7489) FAILS for the visible
 * From-domain — even though the message is a perfectly legitimate forward.
 *
 * ARC (RFC 8617) closes that gap: each participating hop seals, into the
 * message, (a) the authentication results IT observed and (b) a chain of seals
 * so a later verifier can confirm the attestation was not tampered with. If we
 * TRUST the outermost sealer (it is on the operator's forwarder allow-list) AND
 * its sealed Authentication-Results attest the ORIGINAL passed, we can honour
 * that attestation and NOT route the message to Spam on the DMARC fail alone.
 *
 * The cardinal rule (honesty audit): the override fires ONLY when every part is
 * present — a validating chain (`cv=pass`), a KNOWN sealer we chose to trust,
 * and an attestation the original actually passed. Trust is never assumed from
 * the presence of ARC headers (any spammer can add unsigned ones); it rests on
 * the cryptographic chain plus an explicit operator allow-list.
 */

/** RFC 8617 chain-validation state (`cv=`): the whole ARC chain verified, or not. */
export type ArcChainResult = 'pass' | 'fail' | 'none';

/**
 * The ARC verdict the MTA extracts from the raw message, threaded to Convex so
 * the delivery mutation can apply the trusted-forwarder override. All fields are
 * optional — an older MTA (or a message with no ARC headers) sends them absent,
 * which yields no override (fail-closed: absence never rescues a DMARC fail).
 */
export interface ArcOverrideInput {
	/** ARC chain-validation result (`cv=`). Only `pass` is eligible to rescue. */
	arcCv?: string;
	/**
	 * The `d=` domain of the OUTERMOST ARC seal — the forwarder vouching for the
	 * message. This is the identity checked against the trusted-forwarder list.
	 */
	arcSealerDomain?: string;
	/**
	 * Whether the sealer's sealed ARC-Authentication-Results attest that the
	 * ORIGINAL message passed DMARC (or carried an aligned, passing SPF/DKIM).
	 * We only honour a rescue when the trusted forwarder actually saw the
	 * original pass — a forwarder that sealed a FAIL earns no override.
	 */
	arcAttestsOriginalPass?: boolean;
}

/**
 * Seeded default trusted forwarders — well-known mailing-list / forwarding
 * providers that ARC-seal on relay. These are the operator's STARTING point;
 * the list is editable in Settings → Delivery, and an operator can add their own
 * lists or remove any of these. Kept deliberately small and conservative:
 * every entry here is a domain whose ARC seal we are willing to treat as
 * authoritative about a forwarded message's original authentication.
 */
export const DEFAULT_TRUSTED_ARC_FORWARDERS: readonly string[] = [
	'google.com', // Gmail forwarding / "send mail as"
	'groups.google.com', // Google Groups mailing lists
	'googlegroups.com',
	'outlook.com', // Microsoft 365 forwarding
	'protonmail.com', // Proton forwarding
	'lists.sourceforge.net', // SourceForge Mailman lists
	'list.sr.ht', // sourcehut lists
];

/** Lowercase + strip a single trailing dot + leading/trailing whitespace. */
export function normalizeDomain(domain: string | undefined): string {
	return (domain ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Is `entry` a usable trusted-forwarder domain? A trusted entry must be a bare,
 * dot-bearing hostname with no internal whitespace — a single label (`com`) is
 * rejected because, treated as a suffix, it would trust EVERY sealer under that
 * TLD. This is the server-side floor behind the UI's add-domain guard, so a
 * direct `settings.update` call can't widen who we trust past what the operator
 * could type in the editor.
 */
export function isValidForwarderDomain(entry: string | undefined): boolean {
	const normalized = normalizeDomain(entry);
	return normalized.includes('.') && !/\s/.test(normalized);
}

/**
 * Normalize + validate an operator-supplied trusted-forwarder list: lowercase
 * each entry, drop blanks / single-label / whitespace-bearing entries, and
 * de-duplicate. Applied server-side in `settings.update` so the persisted list
 * can never contain an entry the trust predicate would misread as a wildcard.
 */
export function sanitizeTrustedForwarders(entries: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of entries) {
		if (!isValidForwarderDomain(entry)) continue;
		const normalized = normalizeDomain(entry);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

/**
 * Is `sealerDomain` covered by the trusted-forwarder allow-list? A match is
 * either an exact domain equality or the sealer being a SUBDOMAIN of a trusted
 * entry (`mail-a.google.com` is trusted when `google.com` is listed) — the
 * sub-label case matters because large forwarders seal from per-shard hostnames.
 * We deliberately do NOT do the reverse (a trusted `mail.acme.com` never trusts
 * a bare `acme.com`) and never treat a bare single-label entry as a wildcard.
 * Empty inputs never match — an unknown sealer can't be asserted trusted.
 */
export function isTrustedForwarder(
	sealerDomain: string | undefined,
	trustedForwarders: readonly string[]
): boolean {
	const sealer = normalizeDomain(sealerDomain);
	if (!sealer) return false;
	for (const entry of trustedForwarders) {
		const trusted = normalizeDomain(entry);
		if (!trusted) continue;
		if (sealer === trusted) return true;
		// A single-label entry (a typo'd or malicious `com`) is NEVER a suffix
		// wildcard — only its exact match above counts — so it can't trust every
		// sealer under a TLD. Suffix matching applies to dot-bearing entries only.
		if (trusted.includes('.') && sealer.endsWith('.' + trusted)) return true;
	}
	return false;
}

/**
 * The single rescue predicate: should a DMARC fail be OVERRIDDEN because a
 * trusted forwarder's validated ARC chain attests the original passed? True iff
 * ALL of: the chain validated (`cv=pass`), the outermost sealer is on the
 * trusted-forwarder list, and its sealed Authentication-Results attest the
 * original passed. Pure — the honesty audit enumerates every reachable branch.
 */
export function shouldArcOverrideDmarc(
	input: ArcOverrideInput,
	trustedForwarders: readonly string[]
): boolean {
	if (normalizeDomain(input.arcCv) !== 'pass') return false;
	if (input.arcAttestsOriginalPass !== true) return false;
	return isTrustedForwarder(input.arcSealerDomain, trustedForwarders);
}
