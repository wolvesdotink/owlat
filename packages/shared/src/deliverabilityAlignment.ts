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
 */

import { organizationalDomain } from './spfAlignment';
import { evaluateSpfCoexistence } from './spfCoexistence';
import type { SpfCoexistenceFailure } from './spfCoexistence';

export const ALIGNMENT_CHECK_IDS = ['from_domain', 'spf', 'dkim', 'dmarc'] as const;
export type AlignmentCheckId = (typeof ALIGNMENT_CHECK_IDS)[number];

/** `unknown` is the DNS-could-not-answer state: hold, never pass, never fail. */
export type AlignmentCheckStatus = 'pass' | 'fail' | 'unknown';

export type AlignmentVerdict = 'aligned' | 'single_arm' | 'blocked' | 'unknown';

/** Daily re-check cadence, and the faster retry for an unresolved lookup. */
export const ALIGNMENT_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const ALIGNMENT_UNKNOWN_RETRY_MS = 60 * 60 * 1000;

/** Domains re-checked per sweep page, so the cron stays bounded (D16). */
export const ALIGNMENT_SWEEP_PAGE_SIZE = 5;
/** Pages one sweep run walks before handing off to a scheduled continuation. */
export const ALIGNMENT_SWEEP_MAX_PAGES = 5;

export type DnsLookupFailure = 'timeout' | 'servfail' | 'refused' | 'error';

/**
 * A DNS observation. `absent` is an authoritative "no such record" (NXDOMAIN or
 * an empty answer); `unknown` is "we could not find out" and is never laundered
 * into either of the other two.
 */
export type DnsTxtObservation =
	| { state: 'found'; records: readonly string[] }
	| { state: 'absent' }
	| { state: 'unknown'; failure: DnsLookupFailure };

/** One sending arm's identity configuration, as it is actually configured. */
export interface AlignmentArm {
	/** Human-readable arm label used in remedies, e.g. `own MTA` / `SES relay`. */
	label: string;
	/** RFC5322.From domain this arm sends with. */
	fromDomain: string;
	/** The DKIM `d=` this arm signs with. */
	dkimDomain: string;
	/** Selectors this arm may sign with; at least one must be live. */
	dkimSelectors: readonly string[];
	/** SPF mechanisms this arm needs authorized, e.g. `ip4:…` / `include:…`. */
	spfMechanisms: readonly string[];
}

/**
 * The reference arm additionally declares whether it can carry our VERP return
 * path (P2-3). The own MTA always can, so the flag lives HERE rather than on
 * every arm — a field only one shape can meaningfully answer.
 */
export interface ReferenceAlignmentArm extends AlignmentArm {
	/** False when the transport cannot carry our VERP return path. */
	supportsCustomReturnPath: boolean;
}

/**
 * How the second arm stands. Three states, not a boolean:
 *  - `none`    — no reference transport at all. The supported standalone
 *                deployment (D2): nothing to align, the gate opens.
 *  - `unknown` — a relay IS configured but we cannot describe its signing
 *                identity. HOLD; never laundered into `none`.
 *  - `arm`     — the relay's identity is known and can be checked.
 */
export type ReferenceArmInput =
	| { kind: 'none' }
	| { kind: 'unknown'; detail: string }
	| { kind: 'arm'; arm: ReferenceAlignmentArm };

export interface AlignmentDnsFacts {
	/** TXT at the From domain (the SPF record lives here). */
	fromDomainTxt: DnsTxtObservation;
	/** TXT at `_dmarc.<fromDomain>`. */
	dmarcTxt: DnsTxtObservation;
	/** TXT keyed by the FULL name `${selector}._domainkey.${dkimDomain}`. */
	dkimTxt: Readonly<Record<string, DnsTxtObservation>>;
}

export interface AlignmentPreflightInput {
	ownArm: AlignmentArm;
	reference: ReferenceArmInput;
	dns: AlignmentDnsFacts;
	checkedAt: number;
}

export interface AlignmentCheckResult {
	id: AlignmentCheckId;
	status: AlignmentCheckStatus;
	/** What was observed, in readiness-card voice. */
	detail: string;
	/** What to do about it. Empty only when the check passes. */
	remedy: string;
}

export interface AlignmentPreflightResult {
	verdict: AlignmentVerdict;
	checks: AlignmentCheckResult[];
	/** The gate: may the controller move this cell above s=0? */
	allowsShareAboveZero: boolean;
	/** Return-Path could not be aligned — measurement is degraded, not blocked. */
	isMeasurementDegraded: boolean;
	measurementDegradedReason: string | null;
	checkedAt: number;
	nextCheckDueAt: number;
}

/** Base remedy copy, keyed by failure reason, so the UI and tests share one source. */
export const ALIGNMENT_REMEDIES = {
	from_domain_mismatch:
		'Send both arms from the same From domain. Per-transport subdomains split domain reputation and make the two arms incomparable; use per-stream subdomains instead.',
	spf_no_record: 'Publish one v=spf1 TXT record on the From domain that authorizes both arms.',
	spf_multiple_records:
		'Remove the extra v=spf1 TXT record — RFC 7208 allows exactly one per host, and a second one fails SPF for every sender on this domain.',
	spf_missing_mechanism:
		'Add the missing mechanism to the existing v=spf1 record instead of publishing a second record.',
	spf_lookup_limit:
		'The merged SPF record exceeds the RFC 7208 10-lookup limit and will PermError.',
	spf_own_arm_unknown:
		'Set MTA_IP_POOLS so the pre-flight knows which addresses the own MTA sends from. Until then the SPF check cannot prove your own IPs are authorized, and the cell holds.',
	dkim_missing_record: 'Publish the DKIM public key for this selector before ramping.',
	dkim_revoked: 'The published DKIM key is empty (revoked). Republish the public key.',
	dkim_domain_mismatch:
		'Sign both arms with the same DKIM d= domain. A per-transport signing domain throws away the reputation the other arm built.',
	dkim_selector_collision:
		'Give each arm its own DKIM selector — one selector cannot hold two different public keys.',
	dkim_unaligned:
		'Align the DKIM d= with the From domain, otherwise DMARC cannot pass on this arm.',
	dmarc_missing_record: 'Publish a _dmarc TXT record for the From domain.',
	dmarc_multiple_records: 'Remove the extra _dmarc TXT record — only one DMARC record is valid.',
	dmarc_strict_alignment:
		'This domain publishes adkim=s, so every arm must sign with d= exactly equal to the From domain.',
	dns_unknown:
		'DNS could not be resolved. The cell holds at its current share until the lookup succeeds; no configuration change is implied.',
	reference_arm_unknown:
		'A relay is configured but we cannot see the domain it signs and bounces as, so the two arms cannot be compared. Verify the relay for this sending domain (or turn the relay off to run on the own MTA alone).',
} as const;

/** Trim, lowercase and drop a trailing root dot. ONE spelling of a DNS name. */
export function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * The FULL TXT name a DKIM key is published at. The gather keys its observations
 * by exactly this string and the evaluator looks them up by it, so both sides
 * must call this one function — a second spelling silently turns every DKIM
 * check into `unknown`.
 */
export function dkimRecordName(selector: string, dkimDomain: string): string {
	return `${selector.trim().toLowerCase()}._domainkey.${normalizeDomain(dkimDomain)}`;
}

function unknownCheck(id: AlignmentCheckId, detail: string, remedy?: string): AlignmentCheckResult {
	return { id, status: 'unknown', detail, remedy: remedy ?? ALIGNMENT_REMEDIES.dns_unknown };
}

function pass(id: AlignmentCheckId, detail: string): AlignmentCheckResult {
	return { id, status: 'pass', detail, remedy: '' };
}

function fail(id: AlignmentCheckId, detail: string, remedy: string): AlignmentCheckResult {
	return { id, status: 'fail', detail, remedy };
}

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

function spfRemedy(result: SpfCoexistenceFailure): string {
	switch (result.kind) {
		case 'no_record':
			return ALIGNMENT_REMEDIES.spf_no_record;
		case 'multiple_records':
			return ALIGNMENT_REMEDIES.spf_multiple_records;
		case 'missing_mechanism':
			return `${ALIGNMENT_REMEDIES.spf_missing_mechanism} Missing: ${result.missingMechanisms.join(', ')}.`;
		case 'lookup_limit':
			return result.flattenCandidate === null
				? ALIGNMENT_REMEDIES.spf_lookup_limit
				: `${ALIGNMENT_REMEDIES.spf_lookup_limit} Flatten ${result.flattenCandidate} to ip4/ip6 mechanisms to get back under the limit.`;
	}
}

function spfDetail(result: SpfCoexistenceFailure): string {
	switch (result.kind) {
		case 'no_record':
			return 'No v=spf1 record is published on the From domain.';
		case 'multiple_records':
			return `${result.recordCount} v=spf1 records are published on the From domain; RFC 7208 allows one.`;
		case 'missing_mechanism':
			return `The published SPF record does not authorize ${result.missingMechanisms.join(', ')}.`;
		case 'lookup_limit':
			return `The merged SPF record needs ${result.lookupCount} DNS lookups; RFC 7208 allows 10.`;
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
	return fail('spf', spfDetail(result), spfRemedy(result));
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
			allowsShareAboveZero: true,
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
			allowsShareAboveZero: false,
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
		allowsShareAboveZero: verdict === 'aligned',
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
