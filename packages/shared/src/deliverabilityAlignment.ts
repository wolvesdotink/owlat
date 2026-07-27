/**
 * Dual-transport alignment pre-flight (P3-5).
 *
 * The two arms of a ramp cell must be INDISTINGUISHABLE TO THE RECEIVER in
 * everything except the sending infrastructure. If the own-MTA arm and the
 * reference-transport arm differ in From domain, in the DKIM `d=`, or in what
 * the domain's single SPF record authorizes, then the difference the controller
 * measures is DMARC alignment, not deliverability — and the ramp would be
 * driven by an artefact of our own configuration.
 *
 * So: a cell is BLOCKED from any share above 0 until all four checks pass live
 * on BOTH arms, re-verified daily.
 *
 *  1. FROM DOMAIN — identical on both arms. Blocking; the whole design rests on
 *     it. Giving the own-MTA arm its own subdomain splits domain reputation and
 *     makes the arms incomparable (D11) — that is a hard failure here, not a
 *     warning. Per-STREAM subdomains are a different, legitimate thing.
 *  2. SPF — one record covering the MTA's addresses AND the relay's `include:`,
 *     within RFC 7208's 10-lookup limit (`./spfCoexistence`). The own arm's
 *     mechanisms must be KNOWN: a check that cannot name what authorizes our own
 *     IPs would pass on a relay-only record, so zero own-arm mechanisms is
 *     `unknown` (hold), never a pass.
 *  3. DKIM — both arms sign for the SAME `d=` with DISTINCT selectors, proven by
 *     live DNS.
 *  4. DMARC — a policy is published for the From domain and both arms' `d=`
 *     satisfy its alignment mode. The policy is identical by construction (same
 *     domain), so what is verified is that both arms actually align to it.
 *
 * Return-Path state is RECORDED, never blocking: a relay that cannot carry our
 * VERP return path only flags the cell's measurement as degraded.
 *
 * D2 — THE ADDITIVE-ONLY THIRD-PARTY RULE: with NO reference transport there is
 * no second arm and therefore nothing to align. The pre-flight then passes
 * trivially as `single_arm` — no error, no warning, no block. This is the single
 * easiest place in the plan to accidentally make an ESP mandatory.
 *
 * The third reference state is the one that keeps that rule honest without
 * opening a hole: a relay IS configured but its signing identity is not known to
 * us. That is `unknown` — a HOLD — never `single_arm`, because answering "no
 * second arm" for a transport we simply failed to describe would let two
 * genuinely unaligned arms ramp.
 *
 * DNS failure semantics: a timeout / SERVFAIL / REFUSED is UNKNOWN, never
 * "aligned" and never "misconfigured". Unknown HOLDS the cell (it cannot ramp)
 * without raising a failure, and is retried sooner than the daily cadence.
 *
 * Pure: no DNS, no clock, no Convex — every input, including `checkedAt`, is a
 * parameter (D15).
 *
 * The VOCABULARY this speaks — the types, the four check ids, the remedy copy, the
 * DNS-name spellings and the check-result constructors — lives in
 * `./deliverabilityAlignmentVocabulary` and is re-exported from here, so this file
 * is only the four checks and the verdict, and consumers still have one import
 * path.
 */

import { organizationalDomain } from './spfAlignment';
import { evaluateSpfCoexistence } from './spfCoexistence';
import type { SpfCoexistenceFailure } from './spfCoexistence';
import {
	ALIGNMENT_CHECK_IDS,
	ALIGNMENT_RECHECK_INTERVAL_MS,
	ALIGNMENT_REMEDIES,
	ALIGNMENT_UNKNOWN_RETRY_MS,
	dkimRecordName,
	fail,
	normalizeDomain,
	pass,
	unknownCheck,
	type AlignmentArm,
	type AlignmentCheckResult,
	type AlignmentDnsFacts,
	type AlignmentPreflightInput,
	type AlignmentPreflightResult,
	type AlignmentVerdict,
} from './deliverabilityAlignmentVocabulary';

// The vocabulary is re-exported so `@owlat/shared/deliverabilityAlignment` stays
// the single import path for everything this feature speaks.
export * from './deliverabilityAlignmentVocabulary';

function checkFromDomain(own: AlignmentArm, reference: AlignmentArm): AlignmentCheckResult {
	const ownDomain = normalizeDomain(own.fromDomain);
	const referenceDomain = normalizeDomain(reference.fromDomain);
	if (ownDomain !== '' && ownDomain === referenceDomain) {
		return pass('from_domain', `Both arms send from ${ownDomain}.`);
	}
	return fail(
		'from_domain',
		`${own.label} sends from ${ownDomain || '(unset)'} but ${reference.label} sends from ${referenceDomain || '(unset)'}.`,
		ALIGNMENT_REMEDIES.from_domain_mismatch
	);
}

/**
 * ONE switch over `SpfCoexistenceFailure`, returning both halves of the copy.
 *
 * Two switches over the same union — one for the detail, one for the remedy —
 * are two places a new failure variant has to be remembered in, and the compiler
 * cannot tell you that you handled it in only one of them. They were always
 * called from the same statement, so they are one function.
 */
function spfFailureCopy(result: SpfCoexistenceFailure): { detail: string; remedy: string } {
	switch (result.kind) {
		case 'no_record':
			return {
				detail: 'No v=spf1 record is published on the From domain.',
				remedy: ALIGNMENT_REMEDIES.spf_no_record,
			};
		case 'multiple_records':
			return {
				detail: `${result.recordCount} v=spf1 records are published on the From domain; RFC 7208 allows one.`,
				remedy: ALIGNMENT_REMEDIES.spf_multiple_records,
			};
		case 'missing_mechanism':
			return {
				detail: `The published SPF record does not authorize ${result.missingMechanisms.join(', ')}.`,
				remedy: `${ALIGNMENT_REMEDIES.spf_missing_mechanism} Missing: ${result.missingMechanisms.join(', ')}.`,
			};
		case 'lookup_limit':
			return {
				detail: `The merged SPF record needs ${result.lookupCount} DNS lookups; RFC 7208 allows 10.`,
				remedy:
					result.flattenCandidate === null
						? ALIGNMENT_REMEDIES.spf_lookup_limit
						: `${ALIGNMENT_REMEDIES.spf_lookup_limit} Flatten ${result.flattenCandidate} to ip4/ip6 mechanisms to get back under the limit.`,
			};
	}
}

function checkSpf(input: AlignmentPreflightInput, reference: AlignmentArm): AlignmentCheckResult {
	const fromDomain = normalizeDomain(input.ownArm.fromDomain);
	// A check that cannot name what authorizes OUR OWN addresses would pass on a
	// relay-only record. That is not "aligned", it is "not knowable" — hold.
	if (input.ownArm.spfMechanisms.length === 0) {
		return unknownCheck(
			'spf',
			`The own MTA's SPF mechanisms for ${fromDomain} are not known, so the record cannot be proven to authorize both arms.`,
			ALIGNMENT_REMEDIES.spf_own_arm_unknown
		);
	}
	const observation = input.dns.fromDomainTxt;
	if (observation.state === 'unknown') {
		return unknownCheck('spf', `SPF lookup for ${fromDomain} returned ${observation.failure}.`);
	}
	const result = evaluateSpfCoexistence({
		publishedTxtRecords: observation.state === 'found' ? observation.records : [],
		requiredMechanisms: [...input.ownArm.spfMechanisms, ...reference.spfMechanisms],
	});
	if (result.kind === 'pass') {
		return pass(
			'spf',
			`One SPF record authorizes both arms (${result.lookupCount} of 10 DNS lookups used).`
		);
	}
	const copy = spfFailureCopy(result);
	return fail('spf', copy.detail, copy.remedy);
}

/**
 * One arm's DKIM state, as a union: a live arm carries selectors and nothing
 * else, and a failure carries the copy that describes it. `detail`/`remedy` on a
 * pass were fields that meant nothing.
 */
type DkimArmObservation =
	| { kind: 'live'; selectors: string[] }
	| { kind: 'unknown'; detail: string }
	| { kind: 'fail'; detail: string; remedy: string };

/** Resolve one arm's selectors: at least one live key is required. */
function observeArmDkim(arm: AlignmentArm, dns: AlignmentDnsFacts): DkimArmObservation {
	const live: string[] = [];
	let sawUnknown = false;
	let sawRevoked = false;
	for (const selector of arm.dkimSelectors) {
		const observation = dns.dkimTxt[dkimRecordName(selector, arm.dkimDomain)];
		if (observation === undefined || observation.state === 'unknown') {
			sawUnknown = true;
			continue;
		}
		if (observation.state === 'absent') continue;
		const key = observation.records.find((record) => /(^|;)\s*v\s*=\s*dkim1/i.test(record));
		if (key === undefined) continue;
		if (/(^|;)\s*p\s*=\s*(;|$)/i.test(key)) {
			sawRevoked = true;
			continue;
		}
		live.push(selector.trim().toLowerCase());
	}
	if (live.length > 0) return { kind: 'live', selectors: live };
	if (sawUnknown) {
		return { kind: 'unknown', detail: `DKIM lookup for ${arm.label} could not be resolved.` };
	}
	if (sawRevoked) {
		return {
			kind: 'fail',
			detail: `${arm.label} publishes a revoked (empty p=) DKIM key.`,
			remedy: ALIGNMENT_REMEDIES.dkim_revoked,
		};
	}
	const names = arm.dkimSelectors
		.map((selector) => dkimRecordName(selector, arm.dkimDomain))
		.join(', ');
	return {
		kind: 'fail',
		detail: `${arm.label} publishes no DKIM key at ${names || '(no selector configured)'}.`,
		remedy: ALIGNMENT_REMEDIES.dkim_missing_record,
	};
}

function checkDkim(input: AlignmentPreflightInput, reference: AlignmentArm): AlignmentCheckResult {
	const own = input.ownArm;
	const ownDkimDomain = normalizeDomain(own.dkimDomain);
	const referenceDkimDomain = normalizeDomain(reference.dkimDomain);
	if (ownDkimDomain === '' || ownDkimDomain !== referenceDkimDomain) {
		return fail(
			'dkim',
			`${own.label} signs for d=${ownDkimDomain || '(unset)'} but ${reference.label} signs for d=${referenceDkimDomain || '(unset)'}.`,
			ALIGNMENT_REMEDIES.dkim_domain_mismatch
		);
	}
	// A failure outranks an unknown: one pass over the pair, remembering the first
	// unresolved arm in case neither failed.
	let unresolved: string | null = null;
	const liveSelectors: string[][] = [];
	for (const arm of [own, reference]) {
		const observation = observeArmDkim(arm, input.dns);
		if (observation.kind === 'fail') return fail('dkim', observation.detail, observation.remedy);
		if (observation.kind === 'unknown') {
			unresolved ??= observation.detail;
			continue;
		}
		liveSelectors.push(observation.selectors);
	}
	if (unresolved !== null) return unknownCheck('dkim', unresolved);
	const [ownSelectors = [], referenceSelectors = []] = liveSelectors;
	const shared = ownSelectors.filter((selector) => referenceSelectors.includes(selector));
	if (shared.length > 0) {
		return fail(
			'dkim',
			`Both arms sign with the same selector (${shared.join(', ')}).`,
			ALIGNMENT_REMEDIES.dkim_selector_collision
		);
	}
	if (
		organizationalDomain(ownDkimDomain) !== organizationalDomain(normalizeDomain(own.fromDomain))
	) {
		return fail(
			'dkim',
			`d=${ownDkimDomain} does not align with the From domain ${normalizeDomain(own.fromDomain)}.`,
			ALIGNMENT_REMEDIES.dkim_unaligned
		);
	}
	return pass(
		'dkim',
		`Both arms sign d=${ownDkimDomain} with distinct selectors (${ownSelectors.join(', ')} vs ${referenceSelectors.join(', ')}).`
	);
}

function checkDmarc(input: AlignmentPreflightInput, reference: AlignmentArm): AlignmentCheckResult {
	const observation = input.dns.dmarcTxt;
	const fromDomain = normalizeDomain(input.ownArm.fromDomain);
	if (observation.state === 'unknown') {
		return unknownCheck('dmarc', `DMARC lookup for ${fromDomain} returned ${observation.failure}.`);
	}
	const records =
		observation.state === 'found'
			? observation.records.filter((record) => /^\s*v\s*=\s*dmarc1\s*;/i.test(record))
			: [];
	if (records.length === 0) {
		return fail(
			'dmarc',
			`No DMARC record is published at _dmarc.${fromDomain}.`,
			ALIGNMENT_REMEDIES.dmarc_missing_record
		);
	}
	if (records.length > 1) {
		return fail(
			'dmarc',
			`${records.length} DMARC records are published at _dmarc.${fromDomain}.`,
			ALIGNMENT_REMEDIES.dmarc_multiple_records
		);
	}
	const record = records[0] ?? '';
	const strictDkim = /(^|;)\s*adkim\s*=\s*s\s*(;|$)/i.test(record);
	if (strictDkim) {
		const unaligned = [input.ownArm, reference].filter(
			(arm) => normalizeDomain(arm.dkimDomain) !== fromDomain
		);
		if (unaligned.length > 0) {
			return fail(
				'dmarc',
				`adkim=s requires d= to equal ${fromDomain}; ${unaligned.map((arm) => arm.label).join(', ')} does not.`,
				ALIGNMENT_REMEDIES.dmarc_strict_alignment
			);
		}
	}
	return pass(
		'dmarc',
		`DMARC is published at _dmarc.${fromDomain} and both arms align under ${strictDkim ? 'strict' : 'relaxed'} DKIM alignment.`
	);
}

function verdictFor(checks: readonly AlignmentCheckResult[]): AlignmentVerdict {
	if (checks.some((check) => check.status === 'fail')) return 'blocked';
	if (checks.some((check) => check.status === 'unknown')) return 'unknown';
	return 'aligned';
}

/**
 * The pre-flight. With no reference arm it returns `single_arm` and allows the
 * ramp — absence of a third-party transport is a SUPPORTED CONFIGURATION (D2).
 * With a relay whose identity we cannot see it returns `unknown` and HOLDS.
 */
export function evaluateAlignmentPreflight(
	input: AlignmentPreflightInput
): AlignmentPreflightResult {
	const reference = input.reference;
	if (reference.kind === 'none') {
		return {
			verdict: 'single_arm',
			checks: ALIGNMENT_CHECK_IDS.map((id) =>
				pass(id, 'Single arm — no reference transport is configured, so there is nothing to align.')
			),
			isMeasurementDegraded: false,
			measurementDegradedReason: null,
			checkedAt: input.checkedAt,
			nextCheckDueAt: input.checkedAt + ALIGNMENT_RECHECK_INTERVAL_MS,
		};
	}
	if (reference.kind === 'unknown') {
		return {
			verdict: 'unknown',
			checks: ALIGNMENT_CHECK_IDS.map((id) =>
				unknownCheck(id, reference.detail, ALIGNMENT_REMEDIES.reference_arm_unknown)
			),
			isMeasurementDegraded: false,
			measurementDegradedReason: null,
			checkedAt: input.checkedAt,
			nextCheckDueAt: input.checkedAt + ALIGNMENT_UNKNOWN_RETRY_MS,
		};
	}
	const arm = reference.arm;
	const checks = [
		checkFromDomain(input.ownArm, arm),
		checkSpf(input, arm),
		checkDkim(input, arm),
		checkDmarc(input, arm),
	];
	const verdict = verdictFor(checks);
	const isMeasurementDegraded = !arm.supportsCustomReturnPath;
	return {
		verdict,
		checks,
		isMeasurementDegraded,
		measurementDegradedReason: isMeasurementDegraded
			? `${arm.label} cannot carry our custom return path, so bounce attribution on that arm is coarser. Measurement confidence is lowered; the ramp is not blocked.`
			: null,
		checkedAt: input.checkedAt,
		nextCheckDueAt:
			input.checkedAt +
			(verdict === 'unknown' ? ALIGNMENT_UNKNOWN_RETRY_MS : ALIGNMENT_RECHECK_INTERVAL_MS),
	};
}
