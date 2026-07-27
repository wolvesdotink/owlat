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
 *     within RFC 7208's 10-lookup limit (`./spfCoexistence`).
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
 * DNS failure semantics: a timeout / SERVFAIL / REFUSED is UNKNOWN, never
 * "aligned" and never "misconfigured". Unknown HOLDS the cell (it cannot ramp)
 * without raising a failure, and is retried sooner than the daily cadence.
 *
 * Pure: no DNS, no clock, no Convex — every input, including `checkedAt`, is a
 * parameter (D15).
 */

import { organizationalDomain } from './spfAlignment';
import { evaluateSpfCoexistence } from './spfCoexistence';
import type { SpfCoexistenceResult } from './spfCoexistence';

export const ALIGNMENT_CHECK_IDS = ['from_domain', 'spf', 'dkim', 'dmarc'] as const;
export type AlignmentCheckId = (typeof ALIGNMENT_CHECK_IDS)[number];

/** `unknown` is the DNS-could-not-answer state: hold, never pass, never fail. */
export type AlignmentCheckStatus = 'pass' | 'fail' | 'unknown';

export type AlignmentVerdict = 'aligned' | 'single_arm' | 'blocked' | 'unknown';

/** Daily re-check cadence, and the faster retry for an unresolved lookup. */
export const ALIGNMENT_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const ALIGNMENT_UNKNOWN_RETRY_MS = 60 * 60 * 1000;
/** Beyond this, a recorded verdict is no longer evidence of anything. */
export const ALIGNMENT_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

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
	/** False when the transport cannot carry our VERP return path (P2-3). */
	supportsCustomReturnPath: boolean;
}

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
	/** null ⇒ no reference transport is configured. NOT an error (D2). */
	referenceArm: AlignmentArm | null;
	dns: AlignmentDnsFacts;
	includeLookupCosts?: Readonly<Record<string, number>> | undefined;
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
	degradedMeasurement: boolean;
	degradedMeasurementReason: string | null;
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
} as const;

export type AlignmentRemedyKey = keyof typeof ALIGNMENT_REMEDIES;

function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/\.$/, '');
}

function dkimRecordName(selector: string, dkimDomain: string): string {
	return `${selector.trim().toLowerCase()}._domainkey.${normalizeDomain(dkimDomain)}`;
}

function unknownCheck(id: AlignmentCheckId, detail: string): AlignmentCheckResult {
	return { id, status: 'unknown', detail, remedy: ALIGNMENT_REMEDIES.dns_unknown };
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

function spfRemedy(result: SpfCoexistenceResult): string {
	switch (result.reason) {
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
		case 'ok':
			return '';
	}
}

function checkSpf(input: AlignmentPreflightInput, reference: AlignmentArm): AlignmentCheckResult {
	const observation = input.dns.fromDomainTxt;
	if (observation.state === 'unknown') {
		return unknownCheck(
			'spf',
			`SPF lookup for ${normalizeDomain(input.ownArm.fromDomain)} returned ${observation.failure}.`
		);
	}
	const required = [...input.ownArm.spfMechanisms, ...reference.spfMechanisms];
	const result = evaluateSpfCoexistence({
		publishedTxtRecords: observation.state === 'found' ? observation.records : [],
		requiredMechanisms: required,
		includeLookupCosts: input.includeLookupCosts,
		essentialMechanisms: required,
	});
	if (result.status === 'pass') {
		return pass(
			'spf',
			`One SPF record authorizes both arms (${result.lookupCount} of 10 DNS lookups used).`
		);
	}
	const detail =
		result.reason === 'lookup_limit'
			? `The merged SPF record needs ${result.lookupCount} DNS lookups; RFC 7208 allows 10.`
			: `SPF coexistence check failed: ${result.reason}.`;
	return fail('spf', detail, spfRemedy(result));
}

interface DkimArmObservation {
	status: AlignmentCheckStatus;
	detail: string;
	remedy: string;
	liveSelectors: string[];
}

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
	if (live.length > 0) {
		return { status: 'pass', detail: '', remedy: '', liveSelectors: live };
	}
	if (sawUnknown) {
		return {
			status: 'unknown',
			detail: `DKIM lookup for ${arm.label} could not be resolved.`,
			remedy: ALIGNMENT_REMEDIES.dns_unknown,
			liveSelectors: [],
		};
	}
	return {
		status: 'fail',
		detail: sawRevoked
			? `${arm.label} publishes a revoked (empty p=) DKIM key.`
			: `${arm.label} publishes no DKIM key at ${arm.dkimSelectors.map((selector) => dkimRecordName(selector, arm.dkimDomain)).join(', ') || '(no selector configured)'}.`,
		remedy: sawRevoked ? ALIGNMENT_REMEDIES.dkim_revoked : ALIGNMENT_REMEDIES.dkim_missing_record,
		liveSelectors: [],
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
	const ownObservation = observeArmDkim(own, input.dns);
	const referenceObservation = observeArmDkim(reference, input.dns);
	for (const observation of [ownObservation, referenceObservation]) {
		if (observation.status === 'fail') {
			return fail('dkim', observation.detail, observation.remedy);
		}
	}
	for (const observation of [ownObservation, referenceObservation]) {
		if (observation.status === 'unknown') {
			return unknownCheck('dkim', observation.detail);
		}
	}
	const shared = ownObservation.liveSelectors.filter((selector) =>
		referenceObservation.liveSelectors.includes(selector)
	);
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
		`Both arms sign d=${ownDkimDomain} with distinct selectors (${ownObservation.liveSelectors.join(', ')} vs ${referenceObservation.liveSelectors.join(', ')}).`
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
 */
export function evaluateAlignmentPreflight(
	input: AlignmentPreflightInput
): AlignmentPreflightResult {
	const reference = input.referenceArm;
	if (reference === null) {
		return {
			verdict: 'single_arm',
			checks: ALIGNMENT_CHECK_IDS.map((id) =>
				pass(id, 'Single arm — no reference transport is configured, so there is nothing to align.')
			),
			allowsShareAboveZero: true,
			degradedMeasurement: false,
			degradedMeasurementReason: null,
			checkedAt: input.checkedAt,
			nextCheckDueAt: input.checkedAt + ALIGNMENT_RECHECK_INTERVAL_MS,
		};
	}
	const checks = [
		checkFromDomain(input.ownArm, reference),
		checkSpf(input, reference),
		checkDkim(input, reference),
		checkDmarc(input, reference),
	];
	const verdict = verdictFor(checks);
	const degradedMeasurement = !reference.supportsCustomReturnPath;
	return {
		verdict,
		checks,
		allowsShareAboveZero: verdict === 'aligned',
		degradedMeasurement,
		degradedMeasurementReason: degradedMeasurement
			? `${reference.label} cannot carry our custom return path, so bounce attribution on that arm is coarser. Measurement confidence is lowered; the ramp is not blocked.`
			: null,
		checkedAt: input.checkedAt,
		nextCheckDueAt:
			input.checkedAt +
			(verdict === 'unknown' ? ALIGNMENT_UNKNOWN_RETRY_MS : ALIGNMENT_RECHECK_INTERVAL_MS),
	};
}

export type AlignmentGateReason =
	| 'single_arm'
	| 'aligned'
	| 'blocked'
	| 'unknown_hold'
	| 'not_yet_checked'
	| 'stale';

export interface AlignmentGateState {
	verdict: AlignmentVerdict;
	checkedAt: number;
}

export interface AlignmentGateInput {
	/** False ⇒ no reference transport. The gate opens regardless of state (D2). */
	hasReferenceArm: boolean;
	state: AlignmentGateState | null;
	now: number;
}

export interface AlignmentGateVerdict {
	allowsShareAboveZero: boolean;
	reason: AlignmentGateReason;
}

/**
 * The controller's gate. Everything that is not a fresh, positive verdict HOLDS
 * the cell at s=0 — EXCEPT the single-arm case, which never depends on a stored
 * result at all, so a deployment with zero third-party accounts can never be
 * blocked by a pre-flight that has not run.
 */
export function alignmentGate(input: AlignmentGateInput): AlignmentGateVerdict {
	if (!input.hasReferenceArm) return { allowsShareAboveZero: true, reason: 'single_arm' };
	const state = input.state;
	if (state === null) return { allowsShareAboveZero: false, reason: 'not_yet_checked' };
	if (state.verdict === 'single_arm') return { allowsShareAboveZero: true, reason: 'single_arm' };
	if (!Number.isFinite(state.checkedAt) || input.now - state.checkedAt > ALIGNMENT_STALE_AFTER_MS) {
		return { allowsShareAboveZero: false, reason: 'stale' };
	}
	if (state.verdict === 'aligned') return { allowsShareAboveZero: true, reason: 'aligned' };
	return {
		allowsShareAboveZero: false,
		reason: state.verdict === 'unknown' ? 'unknown_hold' : 'blocked',
	};
}

/** Apply the gate to a proposed share: a blocked cell can only be held at 0. */
export function applyAlignmentGateToShare(share: number, gate: AlignmentGateVerdict): number {
	return gate.allowsShareAboveZero ? share : 0;
}
