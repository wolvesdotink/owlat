/**
 * SPF record merge primitives — shared between the Convex backend (DNS
 * generation / verification) and the web clients (the DNS-panel coexistence
 * hint), so both agree on how to fold our sending mechanisms into a domain's
 * existing SPF record instead of forking the rule.
 *
 * All pure (no DNS / no Convex). RFC 7208 §3.2 allows exactly ONE `v=spf1`
 * record per host — publishing a second one is a PermError that breaks SPF for
 * every sender at that host. So when a domain already publishes an SPF record
 * (e.g. it sends via Google Workspace), our record must be *merged* into it
 * rather than added alongside.
 */

import { parseIpAddress } from './ipAddress';

/**
 * Matches the complete RFC 7208 version term. Punctuation is not a delimiter:
 * `v=spf1:broken` is an unknown version string, not an SPF record.
 */
const SPF_RECORD_RE = /^\s*v=spf1(?:\s|$)/i;

/** The trailing `all` mechanism, with an optional qualifier (`~-+?`). */
const ALL_MECHANISM_RE = /^[~+?-]?all$/i;

/** The bare version token. */
const VERSION_TOKEN_RE = /^v=spf1$/i;

/**
 * True when a TXT value is an SPF record (`v=spf1` case-insensitively, RFC 7208
 * §3.2 allows leading whitespace).
 */
export function isSpfRecord(txt: string): boolean {
	return SPF_RECORD_RE.test(txt);
}

/**
 * The mechanism tokens of an SPF record — everything after the `v=spf1` version
 * token, EXCLUDING the trailing `all` mechanism (e.g. `include:_spf.google.com`,
 * `ip4:203.0.113.10`, `a:mail.example.com`, `mx`). Whitespace is normalised.
 */
export function parseSpfMechanisms(record: string): string[] {
	return record
		.trim()
		.split(/\s+/)
		.filter((token) => token !== '')
		.filter((token) => !VERSION_TOKEN_RE.test(token) && !ALL_MECHANISM_RE.test(token));
}

/**
 * Fold `ours` into `existing`, producing a single valid `v=spf1` record: every
 * mechanism of `ours` that `existing` does not already carry (case-insensitive)
 * is spliced in BEFORE `existing`'s trailing `…all` mechanism (or appended when
 * `existing` has no `all`). `existing`'s trailing qualifier/`all` is preserved,
 * so a hard-fail `-all` stays `-all`.
 *
 * Idempotent: when every mechanism of `ours` is already present, the result is
 * `existing` (whitespace-normalised).
 */
export function mergeSpfRecords(existing: string, ours: string): string {
	const tokens = existing
		.trim()
		.split(/\s+/)
		.filter((token) => token !== '');
	const present = new Set(tokens.map((token) => token.toLowerCase()));
	const allIndex = tokens.findIndex((token) => ALL_MECHANISM_RE.test(token));
	const insertAt = allIndex === -1 ? tokens.length : allIndex;
	const additions = parseSpfMechanisms(ours).filter(
		(mechanism) => !present.has(mechanism.toLowerCase())
	);
	tokens.splice(insertAt, 0, ...additions);
	return tokens.join(' ');
}

/**
 * Machine-check the exact ip4/ip6 mechanism emitted for a source address.
 *
 * This deliberately does not claim to be a complete SPF evaluator (which would
 * need recursive includes, macros, CIDR math, and DNS lookup limits). It is the
 * conservative Phase-6 readiness check for Owlat's own generated pool record:
 * only an exact mechanism proves that this address was intentionally enabled.
 */
export function spfRecordHasExactIpMechanism(record: string, address: string): boolean {
	const parsed = parseIpAddress(address);
	if (!parsed || !isSpfRecord(record)) return false;
	const prefix = `${parsed.family === 'ipv4' ? 'ip4' : 'ip6'}:`;
	return parseSpfMechanisms(record).some((mechanism) => {
		// The explicit `+` qualifier has the same pass semantics as the default
		// qualifier. Neutral/softfail/fail mechanisms do not authorize a source
		// for this conservative readiness gate.
		const normalizedMechanism = mechanism.toLowerCase().replace(/^\+/, '');
		if (/^[?~-]/.test(mechanism)) return false;
		if (!normalizedMechanism.startsWith(prefix)) return false;
		return parseIpAddress(normalizedMechanism.slice(prefix.length))?.address === parsed.address;
	});
}
