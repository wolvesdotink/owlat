/**
 * The dual-transport alignment VOCABULARY (P3-5) — the words the pre-flight
 * speaks, with no logic that decides anything.
 *
 * Types, the four check ids, the DNS-observation union, the operator-facing remedy
 * copy, the two DNS-name spellings and the three check-result constructors. Split
 * out of `deliverabilityAlignment.ts` when the evaluator reached the repo's
 * 500-LOC cap, and the split is along the right seam: this module is what the
 * evaluator, the Convex state layer, the gather and the readiness card ALL need,
 * while the four checks and the verdict are the evaluator's alone. The dependency
 * runs one way — the evaluator imports this, never the reverse.
 *
 * Every name here is re-exported from `./deliverabilityAlignment`, so a consumer
 * has one import path to think about.
 *
 * Pure: no DNS, no clock, no Convex.
 */

export const ALIGNMENT_CHECK_IDS = ['from_domain', 'spf', 'dkim', 'dmarc'] as const;
export type AlignmentCheckId = (typeof ALIGNMENT_CHECK_IDS)[number];

/**
 * `unknown` is the DNS-could-not-answer state: hold, never pass, never fail —
 * the distinction this whole module exists to protect, which is why the union is
 * exported as-const for the Convex validator's parity test to assert against.
 */
export const ALIGNMENT_CHECK_STATUSES = ['pass', 'fail', 'unknown'] as const;
export type AlignmentCheckStatus = (typeof ALIGNMENT_CHECK_STATUSES)[number];

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
	/**
	 * Return-Path could not be aligned — measurement is degraded, not blocked.
	 *
	 * There is deliberately NO `allowsShareAboveZero` here: "may this cell ramp?"
	 * has exactly one answer, and it is `alignmentGate`'s, computed from the STORED
	 * verdict and a clock. A second copy on the evaluation result could only ever
	 * disagree with it.
	 */
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

export function unknownCheck(
	id: AlignmentCheckId,
	detail: string,
	remedy?: string
): AlignmentCheckResult {
	return { id, status: 'unknown', detail, remedy: remedy ?? ALIGNMENT_REMEDIES.dns_unknown };
}

export function pass(id: AlignmentCheckId, detail: string): AlignmentCheckResult {
	return { id, status: 'pass', detail, remedy: '' };
}

export function fail(id: AlignmentCheckId, detail: string, remedy: string): AlignmentCheckResult {
	return { id, status: 'fail', detail, remedy };
}
