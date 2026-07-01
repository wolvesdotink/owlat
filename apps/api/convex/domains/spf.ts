/**
 * SPF policy — shared shape + record builder/inspector for the **Sending
 * domain** provider adapters and the DNS verifier.
 *
 * Three concerns live here, all pure (no Convex / no DNS I/O):
 *
 *  1. **Record generation** — `buildSpfRecordValue` emits a `v=spf1 …` record.
 *     The trailing "all" mechanism is qualified by `SPF_QUALIFIER`; operators
 *     start on the soft-fail default (`~all`) while the authorized IP set is
 *     still settling and flip to the hard-fail `-all` once it is stable
 *     (RFC 7208 §5.1). Publishing a second `v=spf1` record at an apex that
 *     already has one is a `PermError` (RFC 7208 §3.2), so a merge helper
 *     (`mergeSpfIncludeGuidance`) and a duplicate detector (`detectMultipleSpf`)
 *     guard against that.
 *
 *  2. **Alignment** — `isSpfAligned` answers the DMARC question "does the
 *     SPF-authenticated identity (the envelope MAIL FROM / return-path domain)
 *     align with the RFC5322.From domain?" (RFC 7489 §3.1). The MTA's envelope
 *     return-path lives on `RETURN_PATH_DOMAIN` (e.g. `bounces.example.com`),
 *     which does NOT align with a customer From-domain (`acme.com`) under either
 *     `strict` or `relaxed` mode — so an SPF pass on the return-path domain
 *     cannot contribute to DMARC for the From-domain. The fix is either a
 *     per-customer return-path subdomain (`bounce.acme.com`, which aligns under
 *     `relaxed`) or, at minimum, publishing an SPF record for
 *     `RETURN_PATH_DOMAIN` so the return-path itself authenticates (documented
 *     in the DNS guide + `buildReturnPathSpfRecord`).
 *
 *  3. **Return-path SPF** — `buildReturnPathSpfRecord` produces the
 *     `v=spf1 ip4:<pool ip> … -all` record an operator must publish on
 *     `RETURN_PATH_DOMAIN` so the bounce envelope passes SPF at receivers that
 *     check MAIL FROM.
 *
 * The alignment primitives (`isSpfAligned` / `emailDomain` / `AlignmentMode`)
 * live in `@owlat/shared/spfAlignment` so the MTA (envelope construction) and
 * the Convex backend share one definition; they are re-exported here for the
 * domains callers.
 */

export {
	type AlignmentMode,
	isSpfAligned,
	emailDomain,
} from '@owlat/shared/spfAlignment';

// SPF merge is shared with the web clients (the DNS-panel coexistence hint), so
// backend generation/verification and the FE fold our mechanisms into an
// existing record the same way. Re-exported for the domains callers + tests.
export { isSpfRecord, parseSpfMechanisms, mergeSpfRecords } from '@owlat/shared/spf';

import { isSpfRecord, mergeSpfRecords } from '@owlat/shared/spf';

export const SPF_QUALIFIERS = ['~all', '-all', '?all', '+all'] as const;

export type SpfQualifier = (typeof SPF_QUALIFIERS)[number];

/**
 * Default trailing mechanism. A soft-fail (`~all`) is the safe default while an
 * operator is still adding IPs / includes — receivers accept but mark, instead
 * of rejecting legitimate mail sent from an IP not yet listed. Flip to `-all`
 * via `SPF_QUALIFIER` once the authorized IP set is stable.
 */
export const DEFAULT_SPF_QUALIFIER: SpfQualifier = '~all';

export function isSpfQualifier(value: string | undefined | null): value is SpfQualifier {
	return value === '~all' || value === '-all' || value === '?all' || value === '+all';
}

/**
 * Coerce an operator-supplied `SPF_QUALIFIER` string to a valid qualifier,
 * falling back to the soft-fail default for unset/garbage input.
 */
export function resolveSpfQualifier(raw: string | undefined | null): SpfQualifier {
	const trimmed = raw?.trim();
	return isSpfQualifier(trimmed) ? trimmed : DEFAULT_SPF_QUALIFIER;
}

export type SpfRecordParts = {
	/** `include:` host (e.g. an upstream relay's SPF macro). */
	include?: string;
	/** `ip4:` addresses to authorize directly (e.g. each IP pool address). */
	ip4?: readonly string[];
	/** Trailing mechanism qualifier; defaults to the soft-fail `~all`. */
	qualifier?: SpfQualifier;
};

/**
 * Build a `v=spf1 …` record value.
 *
 * Mechanisms are emitted in the order ip4 → include → all. The trailing
 * mechanism is `<qualifier>all` where the qualifier defaults to `~all`.
 */
export function buildSpfRecordValue(parts: SpfRecordParts): string {
	const qualifier = parts.qualifier ?? DEFAULT_SPF_QUALIFIER;
	const mechanisms: string[] = ['v=spf1'];
	for (const ip of parts.ip4 ?? []) {
		const trimmed = ip.trim();
		if (trimmed) mechanisms.push(`ip4:${trimmed}`);
	}
	if (parts.include?.trim()) {
		mechanisms.push(`include:${parts.include.trim()}`);
	}
	mechanisms.push(qualifier);
	return mechanisms.join(' ');
}

/**
 * Build the SPF record an operator must publish on `RETURN_PATH_DOMAIN` so the
 * VERP bounce envelope (`bounce+…@RETURN_PATH_DOMAIN`) passes SPF at receivers
 * that check MAIL FROM. Authorizes each IP-pool address directly.
 */
export function buildReturnPathSpfRecord(
	ip4: readonly string[],
	qualifier: SpfQualifier = DEFAULT_SPF_QUALIFIER,
): string {
	return buildSpfRecordValue({ ip4, qualifier });
}

// ─── Duplicate / existing-record detection ──────────────────────────────────

/**
 * Count how many of the published TXT values at a host are SPF records
 * (`v=spf1` case-insensitively, RFC 7208 §3.2 allows leading whitespace).
 */
export function countSpfRecords(txtValues: readonly string[]): number {
	return txtValues.filter((value) => isSpfRecord(value)).length;
}

/**
 * True when a host already publishes more than one `v=spf1` record. Publishing
 * a second SPF record (rather than merging mechanisms into the existing one) is
 * a `PermError` at every receiver (RFC 7208 §3.2) — SPF is undefined when more
 * than one record matches.
 */
export function detectMultipleSpf(txtValues: readonly string[]): boolean {
	return countSpfRecords(txtValues) > 1;
}

/**
 * When a host already publishes an SPF record, the generator must NOT emit a
 * second one — it must tell the operator to merge the new mechanism into the
 * existing record. Returns merge guidance, or `null` when there is no existing
 * record (safe to publish the generated one as-is).
 */
export function mergeSpfIncludeGuidance(
	existingTxtValues: readonly string[],
	include: string,
): string | null {
	const existing = existingTxtValues.find((value) => isSpfRecord(value));
	if (!existing) return null;
	return (
		`merge include into existing record: the apex already publishes ` +
		`"${existing.trim()}" — do not add a second v=spf1 record (RFC 7208 §3.2 ` +
		`PermError). Insert "include:${include}" before the trailing all mechanism, ` +
		`e.g. "${insertIncludeIntoExisting(existing.trim(), include)}".`
	);
}

/**
 * Splice an `include:` mechanism into an existing `v=spf1 …` record, before the
 * trailing `…all` mechanism (or appended when there is no `all`). Thin wrapper
 * over the shared full-record merge so there is one splice implementation.
 */
export function insertIncludeIntoExisting(existing: string, include: string): string {
	return mergeSpfRecords(existing, `v=spf1 include:${include}`);
}
