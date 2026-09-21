/**
 * Shared OSTR domain types — the wire-level vocabulary every other module
 * (attestation, merkle, scoring, client, observer, registry) builds on.
 *
 * This file is the contract between the parallel-built modules: kind-specific
 * helpers live in their owning directory, but every cross-module shape is
 * declared exactly once, here. See TRUST_REGISTRY_PLAN_2026-08-20.html §5.
 */

/** Every record in the registry is one of these attestation kinds (plan §5). */
export type AttestationKind =
	| 'traffic-summary'
	| 'spam-report-batch'
	| 'trap-hit'
	| 'key-observation'
	| 'posture'
	| 'vouch'
	| 'vouch-revoke'
	| 'appeal'
	| 'response'
	| 'retraction'
	| 'audit-finding';

/** A scored subject: a domain, an IP, or the (IP, domain) pair (plan D2). */
export interface SubjectRef {
	domain?: string;
	ip?: string;
}

/** Half-open observation window, RFC 3339 UTC timestamps. */
export interface AttestationWindow {
	from: string;
	to: string;
}

/**
 * The one record type of the registry. `sig` is an ed25519 signature over the
 * RFC 8785 (JCS) canonical form of the document with `sig` absent, prefixed
 * `ed25519:` and base64-encoded. The author's key is published in DNS at
 * `_ostr.<observer>`.
 */
export interface Attestation<TBody = unknown> {
	v: 1;
	kind: AttestationKind;
	/** Author domain; signing key discoverable at `_ostr.<observer>`. */
	observer: string;
	subject: SubjectRef;
	window?: AttestationWindow;
	body: TBody;
	sig: string;
}

/** An attestation as accepted by a log, before its signature is attached. */
export type UnsignedAttestation<TBody = unknown> = Omit<Attestation<TBody>, 'sig'>;

// ---- Kind-specific bodies (plan §5 table) -------------------------------

/**
 * Log-scale buckets (0, 1-9, 10-99, …) so published counts never expose a
 * single user's action; the bucket value is the power of ten's exponent.
 */
export type LogScaleBucket = number;

export interface TrafficSummaryBody {
	messages: number;
	spfPass: number;
	dkimPass: number;
	dmarcPass: number;
	tlsInbound: number;
	uniqueRecipientsBucket: LogScaleBucket;
	/** Bounce rate bucketed in percent steps to avoid precision leaks. */
	bounceRateBucket: LogScaleBucket;
}

export interface SpamReportBatchBody {
	/** User-initiated, DKIM-evidence-backed reports in the window. */
	reports: number;
	/** Merkle root (hex sha256) over the per-report evidence bundles (§7.2). */
	commitment: string;
}

export interface TrapHitBody {
	hits: number;
}

export interface KeyObservationBody {
	domain: string;
	selector: string;
	/** Base64 SPKI DER of the DKIM public key, or `sha256:<hex>` of it. */
	publicKey: string;
	firstSeen: string;
	lastSeen: string;
	dnssecValidated: boolean;
}

export interface PostureBody {
	dmarcPolicy?: 'none' | 'quarantine' | 'reject';
	dmarcAlignment?: 'relaxed' | 'strict';
	dnssec?: boolean;
	mtaSts?: boolean;
	tlsRpt?: boolean;
	declaredIps?: string[];
	/** RFC 3339 date the domain registration is provably at least as old as. */
	registeredBefore?: string;
	/** Set after a key compromise: disclosure is scored leniently (plan §10). */
	compromiseDisclosure?: {
		rotatedAt: string;
		affectedSelectors: string[];
	};
}

export interface VouchBody {
	/** Free-text bounded scope, e.g. "transactional mail only". */
	scope: string;
	expires: string;
}

export interface VouchRevokeBody {
	/** Log coordinates of the vouch being revoked. */
	vouch: LogEntryRef;
	reason: string;
}

export interface AppealBody {
	/** The attestations being disputed. */
	contested: LogEntryRef[];
	statement: string;
}

export interface ResponseBody {
	appeal: LogEntryRef;
	outcome: 'substantiated' | 'retracted';
	statement: string;
}

export interface RetractionBody {
	supersedes: LogEntryRef;
	reason: string;
}

export interface AuditFindingBody {
	finding:
		| 'equivocation'
		| 'invalid-attestation'
		| 'statistical-outlier'
		| 'unanswered-challenge'
		| 'duplicate-evidence';
	/** Log coordinates of the evidence for the finding. */
	evidence: LogEntryRef[];
	statement: string;
}

// ---- Log coordinates ----------------------------------------------------

/** A specific entry in a specific transparency log. */
export interface LogEntryRef {
	logId: string;
	index: number;
}

/**
 * A sequenced log entry as consumed by the scoring policy: the attestation
 * plus the coordinates and inclusion time the log assigned it. Scoring input
 * is the deterministic merge of entries ordered by (logId, index) (plan §6.2).
 */
export interface SequencedAttestation {
	logId: string;
	index: number;
	/** RFC 3339 inclusion timestamp assigned by the log. */
	loggedAt: string;
	attestation: Attestation;
}

// ---- Scoring output (plan §6.1) ----------------------------------------

export type Tier = 'unknown' | 'establishing' | 'trusted' | 'warned' | 'flagged';

export interface ExplanationGroup {
	/** Stable signal identifier, e.g. `complaint-rate`, `posture`. */
	signal: string;
	/** Signed contribution to the 0-100 score. */
	contribution: number;
	/** Human-readable, deterministic sentence (no timestamps of computation). */
	summary: string;
	/** The attestations this group derives from. */
	evidence: LogEntryRef[];
}

export interface ScoreResult {
	subject: SubjectRef;
	tier: Tier;
	/** 0-100. */
	score: number;
	/** Policy version identifier, e.g. `ostr-policy-v1`. */
	policy: string;
	explanation: ExplanationGroup[];
}
