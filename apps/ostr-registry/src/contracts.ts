/**
 * Service contracts between the registry node's modules. The log, aggregator
 * and HTTP layers are built against these interfaces (and tested with fakes),
 * and the composition root in index.ts wires the real implementations.
 *
 * All methods are Promise-returning even where implementations are
 * synchronous (better-sqlite3), so the contract does not leak the storage
 * choice (plan D1: the embedded store is one operator's choice, not spec).
 */
import type {
	Attestation,
	DiffFeedEntry,
	ScoreResult,
	SequencedAttestation,
	SignedInclusionPromise,
	SignedTreeHead,
	SnapshotFile,
	SubjectRef,
} from '@owlat/ostr-core';

/** Resolves the currently valid verifying keys for an observer domain (`_ostr.<domain>` TXT). */
export interface KeyDirectory {
	verifyingKeys(observerDomain: string): Promise<string[]>;
}

export type SubmitOutcome =
	| { accepted: true; index: number; promise: SignedInclusionPromise; duplicate: boolean }
	| { accepted: false; errors: string[] };

/**
 * The append-only transparency log. Content-neutral: it validates form and
 * signatures (via an injected KeyDirectory), never truth. Entries become
 * covered by a head when publishHead() sequences everything pending.
 */
export interface RegistryLog {
	/** Validate, verify, dedupe and append. `receivedAt` is the log's clock (RFC 3339). */
	submit(candidate: unknown, receivedAt: string): Promise<SubmitOutcome>;
	size(): Promise<number>;
	/** Latest published head; null before the first publishHead(). */
	head(): Promise<SignedTreeHead | null>;
	/** Cover all pending entries with a new signed head at `timestamp`. */
	publishHead(timestamp: string): Promise<SignedTreeHead>;
	entries(start: number, count: number): Promise<SequencedAttestation[]>;
	entry(index: number): Promise<SequencedAttestation | null>;
	/** Hex-encoded audit path per RFC 6962 §2.1. */
	inclusionProof(index: number, treeSize: number): Promise<string[]>;
	consistencyProof(oldSize: number, newSize: number): Promise<string[]>;
}

/**
 * The reference aggregator's materialized view: scores recomputed from the
 * log with @owlat/ostr-core scoring, plus the §8 distribution surfaces.
 */
export interface ScoreIndex {
	/** Recompute every subject's score from the log as of `asOf`. */
	refresh(asOf: string): Promise<{ subjects: number; asOf: string }>;
	score(subject: SubjectRef): Promise<ScoreResult | null>;
	/** The attestations that fed a subject's score, newest first, paginated. */
	evidence(subject: SubjectRef, offset: number, limit: number): Promise<SequencedAttestation[]>;
	/** Latest signed snapshot; null before the first refresh. */
	snapshot(): Promise<SnapshotFile | null>;
	diffSince(seq: number): Promise<DiffFeedEntry[]>;
	/** Full zone file text: TXT tier answers plus the bl./wl. A-record compat views. */
	dnsZone(): Promise<string>;
}

/** Everything the HTTP layer needs — the composition root provides it. */
export interface RegistryServices {
	log: RegistryLog;
	scores: ScoreIndex;
}

/** Convenience alias for handlers that accept a submitted attestation. */
export type SubmittedAttestation = Attestation;

/** Re-exported so http/ tests can build typed subjects without deep imports. */
export type { SubjectRef };
