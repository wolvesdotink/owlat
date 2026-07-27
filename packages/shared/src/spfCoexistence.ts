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

export type SpfCoexistenceReason =
	| 'ok'
	| 'no_record'
	| 'multiple_records'
	| 'missing_mechanism'
	| 'lookup_limit';

export interface SpfCoexistenceInput {
	/** Every TXT value published at the From domain, RFC 1035 chunks already joined. */
	publishedTxtRecords: readonly string[];
	/** Mechanisms both arms need (e.g. `ip4:203.0.113.10`, `include:amazonses.com`). */
	requiredMechanisms: readonly string[];
	/**
	 * Known lookup cost of an `include:` target (the include itself plus every
	 * nested lookup it performs). Unknown targets are counted as the 1 lookup the
	 * include itself always costs — deliberately optimistic, because inventing a
	 * larger number would block a record that actually evaluates.
	 */
	includeLookupCosts?: Readonly<Record<string, number>> | undefined;
	/**
	 * Mechanisms that must NOT be proposed for flattening — the two arms' own
	 * mechanisms, without which there is no second arm to align.
	 */
	essentialMechanisms?: readonly string[] | undefined;
}

export interface SpfCoexistenceResult {
	status: 'pass' | 'fail';
	reason: SpfCoexistenceReason;
	/** The single merged record both arms would share, or null when unmergeable. */
	mergedRecord: string | null;
	/** DNS-lookup term count of the merged record (0 when unmergeable). */
	lookupCount: number;
	/** Required mechanisms the published record does not carry (post-merge: none). */
	missingMechanisms: string[];
	/** The `include:` worth flattening to get back under the limit, when over it. */
	flattenCandidate: string | null;
}

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

/** DNS-lookup cost of one mechanism token (0 for `ip4:`/`ip6:`/`all`/unknown). */
export function mechanismLookupCost(
	token: string,
	includeLookupCosts?: Readonly<Record<string, number>> | undefined
): number {
	const normalized = normalizeMechanism(token);
	if (normalized.startsWith('redirect=')) return 1;
	const target = includeTarget(token);
	if (target !== null) {
		const declared = includeLookupCosts?.[target];
		return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
			? Math.floor(declared)
			: 1;
	}
	const name = normalized.split(/[:/]/, 1)[0] ?? '';
	return (LOOKUP_MECHANISMS as readonly string[]).includes(name) ? 1 : 0;
}

/** Total DNS-lookup term count of a `v=spf1` record. */
export function countSpfDnsLookups(
	record: string,
	includeLookupCosts?: Readonly<Record<string, number>> | undefined
): number {
	return parseSpfMechanisms(record).reduce(
		(total, token) => total + mechanismLookupCost(token, includeLookupCosts),
		0
	);
}

/**
 * Pick the `include:` to flatten first: the costliest non-essential include,
 * breaking ties on the LAST occurrence so the recommendation is deterministic.
 */
function pickFlattenCandidate(
	record: string,
	essential: ReadonlySet<string>,
	includeLookupCosts?: Readonly<Record<string, number>> | undefined
): string | null {
	let best: string | null = null;
	let bestCost = 0;
	for (const token of parseSpfMechanisms(record)) {
		const target = includeTarget(token);
		if (target === null) continue;
		const normalized = normalizeMechanism(token);
		if (essential.has(normalized)) continue;
		const cost = mechanismLookupCost(token, includeLookupCosts);
		if (cost >= bestCost) {
			best = normalized;
			bestCost = cost;
		}
	}
	return best;
}

/**
 * Can both arms coexist in the domain's single SPF record?
 *
 * Fails when: no `v=spf1` record is published, MORE THAN ONE is (a PermError in
 * itself), a required mechanism is absent and cannot be merged in, or the merged
 * record exceeds the 10-lookup limit — in which case the result names the
 * include to flatten.
 */
export function evaluateSpfCoexistence(input: SpfCoexistenceInput): SpfCoexistenceResult {
	const spfRecords = input.publishedTxtRecords.filter((txt) => isSpfRecord(txt));
	const base: Omit<SpfCoexistenceResult, 'status' | 'reason'> = {
		mergedRecord: null,
		lookupCount: 0,
		missingMechanisms: [],
		flattenCandidate: null,
	};
	if (spfRecords.length === 0) {
		return {
			...base,
			status: 'fail',
			reason: 'no_record',
			missingMechanisms: [...input.requiredMechanisms],
		};
	}
	if (spfRecords.length > 1) {
		return { ...base, status: 'fail', reason: 'multiple_records' };
	}
	const published = spfRecords[0] ?? '';
	const present = new Set(parseSpfMechanisms(published).map((token) => normalizeMechanism(token)));
	const missing = input.requiredMechanisms.filter(
		(mechanism) => !present.has(normalizeMechanism(mechanism))
	);
	const merged = mergeSpfRecords(published, `v=spf1 ${input.requiredMechanisms.join(' ')}`);
	const lookupCount = countSpfDnsLookups(merged, input.includeLookupCosts);
	if (lookupCount > SPF_MAX_DNS_LOOKUPS) {
		const essential = new Set(
			(input.essentialMechanisms ?? input.requiredMechanisms).map((mechanism) =>
				normalizeMechanism(mechanism)
			)
		);
		return {
			status: 'fail',
			reason: 'lookup_limit',
			mergedRecord: merged,
			lookupCount,
			missingMechanisms: missing,
			flattenCandidate: pickFlattenCandidate(merged, essential, input.includeLookupCosts),
		};
	}
	if (missing.length > 0) {
		return {
			status: 'fail',
			reason: 'missing_mechanism',
			mergedRecord: merged,
			lookupCount,
			missingMechanisms: missing,
			flattenCandidate: null,
		};
	}
	return {
		status: 'pass',
		reason: 'ok',
		mergedRecord: merged,
		lookupCount,
		missingMechanisms: [],
		flattenCandidate: null,
	};
}
