/**
 * SPF policy — shared shape + record builder/inspector for the **Sending
 * domain** provider adapters and the DNS verifier.
 *
 * Relay note: when the outbound transport is a generic SMTP relay
 * (`EMAIL_PROVIDER=smtp`, see `lib/sendProviders/smtp`), the sending IPs and
 * DKIM signing belong to the RELAY provider, so SPF/DKIM authentication is set
 * up in that provider's dashboard against the From-domain — not through this
 * built-in-MTA record bundle. The operator-facing transport UX for this lands
 * in the Sending-transport settings surface (plan piece a4).
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

export { type AlignmentMode, isSpfAligned, emailDomain } from '@owlat/shared/spfAlignment';

// SPF merge is shared with the web clients (the DNS-panel coexistence hint), so
// backend generation/verification and the FE fold our mechanisms into an
// existing record the same way. Re-exported for the domains callers + tests.
export { isSpfRecord, mergeSpfRecords } from '@owlat/shared/spf';

import { isSpfRecord, mergeSpfRecords } from '@owlat/shared/spf';
import { parseIpAddress } from '@owlat/shared/ipAddress';

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
	/** `ip6:` addresses to authorize directly after explicit IPv6 enablement. */
	ip6?: readonly string[];
	/**
	 * Extra, already-validated mechanism terms emitted verbatim after
	 * `include:` and before the trailing `all` — e.g. the relay authorisation
	 * terms a return-path host needs so a relay-stamped bounce envelope passes
	 * SPF. Callers hand these in already parsed; nothing here re-validates them.
	 */
	extra?: readonly string[];
	/** Trailing mechanism qualifier; defaults to the soft-fail `~all`. */
	qualifier?: SpfQualifier;
};

/**
 * Build a `v=spf1 …` record value.
 *
 * Mechanisms are emitted in the order ip4 → ip6 → include → all. The trailing
 * mechanism is `<qualifier>all` where the qualifier defaults to `~all`.
 */
export function buildSpfRecordValue(parts: SpfRecordParts): string {
	const qualifier = parts.qualifier ?? DEFAULT_SPF_QUALIFIER;
	const mechanisms: string[] = ['v=spf1'];
	for (const ip of parts.ip4 ?? []) {
		const trimmed = ip.trim();
		if (trimmed) mechanisms.push(`ip4:${trimmed}`);
	}
	for (const ip of parts.ip6 ?? []) {
		const trimmed = ip.trim();
		if (trimmed) mechanisms.push(`ip6:${trimmed}`);
	}
	if (parts.include?.trim()) {
		mechanisms.push(`include:${parts.include.trim()}`);
	}
	for (const term of parts.extra ?? []) {
		const trimmed = term.trim();
		if (trimmed && !mechanisms.includes(trimmed)) mechanisms.push(trimmed);
	}
	mechanisms.push(qualifier);
	return mechanisms.join(' ');
}

/**
 * SPF mechanism terms accepted as RELAY AUTHORISATION on a return-path host.
 *
 * Deliberately narrow: `include`/`a`/`mx` each cost a DNS lookup against RFC
 * 7208 §4.6.4's budget of ten, and `ptr`/`exists`/`redirect` are either
 * deprecated or capable of relocating the whole evaluation. Anything else in
 * the configured value is IGNORED, never rejected — this value is read on the
 * send path, where throwing would turn a typo into blocked mail (plan D2).
 */
/**
 * Cap on accepted relay-authorisation terms.
 *
 * RFC 7208 §4.6.4 budgets TEN DNS lookups per evaluation, and the generated
 * return-path record already spends some on its own mechanisms. An unbounded
 * configured value would produce a record that PERMERRORs at receivers — and a
 * permerror on the bounce domain evaluates as a FAIL, precisely the outcome the
 * relay-authorisation gate exists to avoid. Five leaves headroom for the rest of
 * the record. Excess terms are dropped silently, per this module's
 * "ignore, never throw" rule.
 */
export const MAX_RELAY_SPF_TERMS = 5;

const RELAY_SPF_TERM_PATTERN =
	/^(?:include:[A-Za-z0-9._-]+|a:[A-Za-z0-9._-]+|mx:[A-Za-z0-9._-]+|ip4:[0-9./]+|ip6:[0-9A-Fa-f:./]+)$/;

/**
 * Parse `MTA_RETURN_PATH_RELAY_SPF` — the mechanism terms that authorise a
 * third-party RELAY to send with a `bounce+…@<return-path host>` envelope
 * sender.
 *
 * The generated return-path SPF record authorises the MTA pool IPs only, so
 * stamping that address on a send leaving through a relay would make receivers
 * evaluate SPF for the bounce domain against the RELAY's IP and fail it. These
 * terms are what closes that gap; until they are configured AND published, the
 * relay VERP stamp stays off and the arm is graded degraded-measurement.
 *
 * Total: comma- or whitespace-separated, case-normalised, de-duplicated,
 * capped at {@link MAX_RELAY_SPF_TERMS}, unrecognised terms dropped. Never
 * throws.
 */
export function parseReturnPathRelaySpfTerms(raw: string | undefined | null): string[] {
	const terms: string[] = [];
	for (const entry of (raw ?? '').split(/[\s,]+/)) {
		const term = entry.trim().toLowerCase();
		if (!term || !RELAY_SPF_TERM_PATTERN.test(term) || terms.includes(term)) continue;
		terms.push(term);
		if (terms.length >= MAX_RELAY_SPF_TERMS) break;
	}
	return terms;
}

/**
 * Build the SPF record an operator must publish on `RETURN_PATH_DOMAIN` so the
 * VERP bounce envelope (`bounce+…@RETURN_PATH_DOMAIN`) passes SPF at receivers
 * that check MAIL FROM. Authorizes each IP-pool address directly, plus any
 * configured relay-authorisation terms (see
 * {@link parseReturnPathRelaySpfTerms}) so the SAME bounce envelope also passes
 * when the message leaves through the relay arm.
 */
export function buildReturnPathSpfRecord(
	poolIps: readonly string[],
	qualifier: SpfQualifier = DEFAULT_SPF_QUALIFIER,
	relaySpfTerms: readonly string[] = []
): string {
	const ip4: string[] = [];
	const ip6: string[] = [];
	for (const value of poolIps) {
		const parsed = parseIpAddress(value);
		if (!parsed) throw new Error(`Invalid MTA pool IP address: ${value}`);
		(parsed.family === 'ipv4' ? ip4 : ip6).push(parsed.address);
	}
	return buildSpfRecordValue({ ip4, ip6, extra: relaySpfTerms, qualifier });
}

/**
 * A `mailFrom` DNS record entry for a return-path host — an absolute-hostname
 * MX (bounce-DSN routing) or TXT (SPF) record.
 */
export type ReturnPathMailFromRecord = {
	readonly type: 'MX' | 'TXT';
	readonly hostname: string;
	readonly value: string;
	readonly priority?: number;
};

/**
 * MX preference for the return-path bounce host. `10` matches the documented
 * global `RETURN_PATH_DOMAIN` guidance (`bounces.<zone> MX 10 mail.<zone>`), the
 * inbound-DNS generator (`apps/web` `INBOUND_MX_PRIORITY`), and the SES MAIL FROM
 * MX — the codebase-wide "single inbound host" convention.
 */
export const RETURN_PATH_MX_PRIORITY = 10;

/**
 * Build the `mailFrom` DNS record bundle for a return-path host:
 *   - an MX record routing bounce DSNs to the MTA's inbound listener
 *     (`<returnPathHost> MX 10 <mailHost>`), so remote MTAs can DELIVER
 *     `bounce+…@<host>` back — SPF alone authorizes only OUTBOUND and does
 *     nothing for inbound DSN routing (this was the gap: a custom host had SPF
 *     but no MX, so bounce attribution/suppression silently stopped); and
 *   - an SPF TXT record authorizing the pool IPs on the host (RFC 7208 §3.1) so
 *     the bounce envelope passes SPF.
 *
 * Pure — the caller resolves `returnPathHost` (per-domain override or the global
 * env), the MTA inbound `mailHost` (EHLO hostname), and the pool IPs. Centralized
 * so the provider's initial registration and the lifecycle's return-path edit
 * emit the exact same bundle for a given host and can't drift.
 *
 * Returns `undefined` when there is no return-path host, or when neither record
 * can be built (no `mailHost` AND no pool IPs). Each record is emitted only when
 * its input is present: the MX needs `mailHost`, the SPF TXT needs pool IPs — a
 * caller with only one still publishes what it can (and warns about the rest).
 *
 * `relaySpfTerms` ADD relay authorisation to a record the pool IPs already
 * justify; they never justify one on their own. An empty pool with configured
 * relay terms therefore emits NO TXT — shipped behaviour, and deliberately so:
 * publishing `v=spf1 include:<relay> ~all` at the bounce host would take the
 * DIRECT-MX arm's own `bounce+…@<host>` envelope sender from SPF `none` to
 * softfail (to FAIL under `SPF_QUALIFIER=-all`), stripping DMARC's SPF leg from
 * exactly the arm the relay stamp exists to make comparable.
 */
export function buildReturnPathMailFromRecords(
	returnPathHost: string | undefined,
	poolIps: readonly string[],
	qualifier: SpfQualifier,
	mailHost: string | undefined,
	relaySpfTerms: readonly string[] = []
): ReturnPathMailFromRecord[] | undefined {
	if (!returnPathHost) return undefined;
	const records: ReturnPathMailFromRecord[] = [];

	const normalizedMailHost = mailHost?.trim().replace(/\.$/, '').toLowerCase();
	if (normalizedMailHost) {
		records.push({
			type: 'MX',
			hostname: returnPathHost,
			value: normalizedMailHost,
			priority: RETURN_PATH_MX_PRIORITY,
		});
	}

	if (poolIps.length > 0) {
		records.push({
			type: 'TXT',
			hostname: returnPathHost,
			value: buildReturnPathSpfRecord(poolIps, qualifier, relaySpfTerms),
		});
	}

	return records.length > 0 ? records : undefined;
}

/**
 * Parse the operator's `MTA_IP_POOLS` env value into a clean IP list — the pool
 * IPs authorized on the return-path SPF record. Shared by initial registration
 * and the return-path edit so both read the env the same way.
 */
export function parsePoolIps(raw: string | undefined | null): string[] {
	const result: string[] = [];
	for (const entry of (raw ?? '')
		.split(',')
		.map((ip) => ip.trim())
		.filter(Boolean)) {
		const parsed = parseIpAddress(entry);
		if (!parsed) throw new Error(`MTA_IP_POOLS contains an invalid bare IP address: ${entry}`);
		if (!result.includes(parsed.address)) result.push(parsed.address);
	}
	return result;
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
	include: string
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
