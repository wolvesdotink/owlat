/**
 * SPF coexistence detector — ONE implementation of "can both sending arms live
 * inside a single `v=spf1` record, and does that record still evaluate?".
 *
 * RFC 7208 §3.2 allows exactly ONE `v=spf1` record per host, and §4.6.4 caps a
 * single evaluation at 10 DNS-lookup terms (`include`, `a`, `mx`, `ptr`,
 * `exists`, and the `redirect=` modifier); the 11th term is a PermError, which
 * receivers treat as an SPF failure for EVERY sender at that host. So folding a
 * relay's `include:` into a record that already carries our pool addresses is
 * not merely a string edit — it has to be checked against the limit BEFORE the
 * dual-transport ramp is allowed to send on both arms.
 *
 * Pure: no DNS, no clock, no Convex. The caller supplies the published TXT set.
 */

import { isSpfRecord, mergeSpfRecords, parseSpfMechanisms } from './spf';

/** RFC 7208 §4.6.4 — at most 10 DNS-lookup terms per evaluation. */
export const SPF_MAX_DNS_LOOKUPS = 10;

/** Mechanisms that each cost one DNS lookup (RFC 7208 §4.6.4). */
const LOOKUP_MECHANISMS = ['include', 'a', 'mx', 'ptr', 'exists'] as const;

export interface SpfCoexistenceInput {
	/** Every TXT value published at the From domain, RFC 1035 chunks already joined. */
	publishedTxtRecords: readonly string[];
	/** Mechanisms both arms need (e.g. `ip4:203.0.113.10`, `include:amazonses.com`). */
	requiredMechanisms: readonly string[];
}

/**
 * The verdict, as a discriminated union: each variant carries ONLY the fields
 * that mean something for it. There is no `missingMechanisms: []` on a pass and
 * no `flattenCandidate: null` on a missing mechanism, so a caller cannot read a
 * field that was never computed.
 */
export type SpfCoexistenceResult =
	| { kind: 'pass'; mergedRecord: string; lookupCount: number }
	| { kind: 'no_record'; missingMechanisms: string[] }
	| { kind: 'multiple_records'; recordCount: number }
	| {
			kind: 'missing_mechanism';
			mergedRecord: string;
			lookupCount: number;
			missingMechanisms: string[];
	  }
	| {
			kind: 'lookup_limit';
			mergedRecord: string;
			lookupCount: number;
			/** The `include:` worth flattening to get back under the limit. */
			flattenCandidate: string | null;
	  };

/** Every variant that is not a pass. */
export type SpfCoexistenceFailure = Exclude<SpfCoexistenceResult, { kind: 'pass' }>;

/** Strip the optional qualifier and lowercase a mechanism token. */
function normalizeMechanism(token: string): string {
	return token.replace(/^[~+?-]/, '').toLowerCase();
}

/** The `include:` target of a token, or null when it is not an include. */
export function includeTarget(token: string): string | null {
	const normalized = normalizeMechanism(token);
	if (!normalized.startsWith('include:')) return null;
	const target = normalized.slice('include:'.length);
	return target === '' ? null : target;
}

/**
 * DNS-lookup cost of one mechanism token: 1 for a lookup term (`include`, `a`,
 * `mx`, `ptr`, `exists`, `redirect=`), 0 for `ip4:`/`ip6:`/`all`/unknown.
 *
 * An `include:` is counted as the ONE lookup the include itself always costs.
 * Its nested lookups are unknowable from a pure function, and inventing a larger
 * number would block a record that actually evaluates.
 */
export function mechanismLookupCost(token: string): number {
	const normalized = normalizeMechanism(token);
	if (normalized.startsWith('redirect=')) return 1;
	if (includeTarget(token) !== null) return 1;
	const name = normalized.split(/[:/]/, 1)[0] ?? '';
	return (LOOKUP_MECHANISMS as readonly string[]).includes(name) ? 1 : 0;
}

/** Total DNS-lookup term count of a `v=spf1` record. */
export function countSpfDnsLookups(record: string): number {
	return parseSpfMechanisms(record).reduce((total, token) => total + mechanismLookupCost(token), 0);
}

/**
 * Pick the `include:` to flatten first: the LAST non-essential include in the
 * merged record, so the recommendation is deterministic. Essential mechanisms
 * are the two arms' own — without them there is no second arm to align, so they
 * are never proposed for flattening.
 */
function pickFlattenCandidate(record: string, essential: ReadonlySet<string>): string | null {
	let candidate: string | null = null;
	for (const token of parseSpfMechanisms(record)) {
		if (includeTarget(token) === null) continue;
		const normalized = normalizeMechanism(token);
		if (essential.has(normalized)) continue;
		candidate = normalized;
	}
	return candidate;
}

/**
 * Can both arms coexist in the domain's single SPF record?
 *
 * Fails when: no `v=spf1` record is published, MORE THAN ONE is (a PermError in
 * itself), the PUBLISHED record does not already authorize a required mechanism,
 * or the merged record exceeds the 10-lookup limit — in which case the result
 * names the include to flatten.
 *
 * The judgement is on what is PUBLISHED, not on what we could merge: `ours ∪
 * theirs` is only the operator's remedy text. The lookup-limit verdict is
 * reported ahead of a missing mechanism, because a record already at the limit
 * cannot be fixed by adding the missing mechanism to it.
 */
export function evaluateSpfCoexistence(input: SpfCoexistenceInput): SpfCoexistenceResult {
	const spfRecords = input.publishedTxtRecords.filter((txt) => isSpfRecord(txt));
	if (spfRecords.length === 0) {
		return { kind: 'no_record', missingMechanisms: [...input.requiredMechanisms] };
	}
	if (spfRecords.length > 1) {
		return { kind: 'multiple_records', recordCount: spfRecords.length };
	}
	const published = spfRecords[0] ?? '';
	const present = new Set(parseSpfMechanisms(published).map((token) => normalizeMechanism(token)));
	const missing = input.requiredMechanisms.filter(
		(mechanism) => !present.has(normalizeMechanism(mechanism))
	);
	const merged = mergeSpfRecords(published, `v=spf1 ${input.requiredMechanisms.join(' ')}`);
	const lookupCount = countSpfDnsLookups(merged);
	if (lookupCount > SPF_MAX_DNS_LOOKUPS) {
		const essential = new Set(input.requiredMechanisms.map(normalizeMechanism));
		return {
			kind: 'lookup_limit',
			mergedRecord: merged,
			lookupCount,
			flattenCandidate: pickFlattenCandidate(merged, essential),
		};
	}
	if (missing.length > 0) {
		return {
			kind: 'missing_mechanism',
			mergedRecord: merged,
			lookupCount,
			missingMechanisms: missing,
		};
	}
	return { kind: 'pass', mergedRecord: merged, lookupCount };
}
