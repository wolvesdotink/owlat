/**
 * Answering a challenge (plan §7.2.4).
 *
 * A published `spam-report-batch` is a count and a root. It becomes evidence
 * only when the observer can OPEN it: a monitor samples indices in
 * `[0, reports)` and the observer returns, for each, the evidence bundle at that
 * position plus its inclusion proof against the commitment it signed. Failing to
 * answer is not neutral — the batch is discarded from scoring and the observer
 * takes a standing penalty (§7.2).
 *
 * That makes the ORDERED bundle-hash list published-side state, not a temporary
 * of the batch builder: a root cannot be re-derived from a set, and a list in a
 * different order produces proofs that fail against the published root. So
 * `buildSpamReportBatch` hands the list back and this module stores it, keyed by
 * the batch's own subject and window, alongside the commitment it produced.
 *
 * WHO SEES WHAT. Openings go to the adjudicating monitors, never to the accused:
 * a bundle contains `h=`-signed headers, which is to say Subject and To. This
 * module returns openings as data; whom the app sends them to is the app's
 * decision, and §7.4 requires that access be logged.
 *
 * Retention couples the two ends: bundles are kept ~90 days, so
 * {@link MemoryBatchCommitmentStore.prune} drops the hash lists on the same
 * cutoff. A challenge to a batch older than retention is unanswerable by
 * design, and the plan's challenge deadline (T ≈ 14 days, §7.6) sits well inside
 * it.
 */
import {
	commitToBundles,
	compareRfc3339,
	isRfc3339,
	openBundles,
	parseHash,
	type AttestationWindow,
	type SubjectRef,
} from '@owlat/ostr-core';
import { subjectKey, type AttestationDraft } from './types.js';

/** What the observer must keep to substantiate one published batch. */
export interface BatchCommitmentRecord {
	subject: SubjectRef;
	window: AttestationWindow;
	/** The published `body.commitment`. */
	commitmentHex: string;
	/** The committed hashes, in commitment order. */
	bundleHashes: string[];
}

/** Where those records live. Synchronous for the same reason the dedupe store
 *  is: an app with a durable async store keeps the working set in memory and
 *  writes through in `put`. */
export interface BatchCommitmentStore {
	get(subject: SubjectRef, window: AttestationWindow): BatchCommitmentRecord | null | undefined;
	put(record: BatchCommitmentRecord): void;
}

/** One sampled bundle, ready to hand a monitor. `bundleHash` and `proof` are
 *  hex so the answer survives JSON; a monitor parses them back and calls
 *  `verifyBundleOpening` with `committedSize` taken from the SIGNED attestation,
 *  never from this answer. */
export interface ChallengeOpening {
	index: number;
	treeSize: number;
	bundleHash: string;
	proof: string[];
}

export type ChallengeRefusal =
	/** Nothing retained for this subject and window — past retention, or the
	 *  batch was never recorded after publication. */
	| 'unknown-batch'
	/** The retained list no longer reproduces the published root: the store was
	 *  reordered or edited, and answering with it would prove nothing. */
	| 'commitment-mismatch'
	/** No indices, or an index outside `[0, reports)`. */
	| 'invalid-indices';

export type ChallengeAnswer =
	| { ok: true; commitmentHex: string; openings: ChallengeOpening[] }
	| { ok: false; reason: ChallengeRefusal };

/**
 * Open the sampled positions of a retained batch.
 *
 * Thin by intention: the Merkle work belongs to `@owlat/ostr-core`
 * (`openBundles`), and what this adds is the retention lookup, the check that
 * the retained list still reproduces the published commitment, and a shape that
 * serializes.
 */
export function answerChallenge(
	record: BatchCommitmentRecord | null | undefined,
	indices: readonly number[]
): ChallengeAnswer {
	if (record === null || record === undefined) return { ok: false, reason: 'unknown-batch' };
	const leaves: Buffer[] = [];
	for (const hex of record.bundleHashes ?? []) {
		const hash = parseHash(hex);
		if (hash === undefined) return { ok: false, reason: 'commitment-mismatch' };
		leaves.push(hash);
	}
	if (leaves.length === 0) return { ok: false, reason: 'unknown-batch' };
	if (!Array.isArray(indices) || indices.length === 0) {
		return { ok: false, reason: 'invalid-indices' };
	}
	if (
		indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= leaves.length)
	) {
		return { ok: false, reason: 'invalid-indices' };
	}
	// The retained list must still produce the root the observer signed;
	// otherwise every opening below would verify against nothing.
	if (commitToBundles(leaves).rootHex !== record.commitmentHex) {
		return { ok: false, reason: 'commitment-mismatch' };
	}

	const openings = openBundles(leaves, indices);
	return {
		ok: true,
		commitmentHex: record.commitmentHex,
		openings: openings.map((opening) => ({
			index: opening.index,
			treeSize: opening.treeSize,
			bundleHash: Buffer.from(opening.bundleHash).toString('hex'),
			proof: opening.proof.map((node) => Buffer.from(node).toString('hex')),
		})),
	};
}

/**
 * Record what `buildSpamReportBatch` committed to, for the batch draft it
 * produced. Call it at publication time, not at build time: a batch that was
 * held or refused is never challengeable.
 *
 * @throws RangeError if the draft carries no window — the log requires one on a
 * `spam-report-batch`, and a record filed under an empty window could never be
 * found again.
 */
export function retainBatchCommitment(
	store: BatchCommitmentStore,
	draft: AttestationDraft<{ commitment: string }>,
	bundleHashes: readonly string[]
): BatchCommitmentRecord {
	const window = draft.window;
	if (window === undefined) {
		throw new RangeError('a spam-report-batch draft must carry the window it commits to');
	}
	const record: BatchCommitmentRecord = {
		subject: draft.subject,
		window,
		commitmentHex: draft.body.commitment,
		bundleHashes: [...bundleHashes],
	};
	store.put(record);
	return record;
}

/** In-memory {@link BatchCommitmentStore} with the same explicit, clock-free
 *  retention prune the dedupe store has. */
export class MemoryBatchCommitmentStore implements BatchCommitmentStore {
	readonly #records = new Map<string, BatchCommitmentRecord>();

	static #key(subject: SubjectRef, window: AttestationWindow): string {
		return `${subjectKey(subject)}\0${window?.from ?? ''}\0${window?.to ?? ''}`;
	}

	get(subject: SubjectRef, window: AttestationWindow): BatchCommitmentRecord | null {
		return this.#records.get(MemoryBatchCommitmentStore.#key(subject, window)) ?? null;
	}

	put(record: BatchCommitmentRecord): void {
		this.#records.set(MemoryBatchCommitmentStore.#key(record.subject, record.window), record);
	}

	/** Forget every batch whose window ended strictly before `cutoff` — the same
	 *  cutoff that deletes the bundles themselves. */
	prune(cutoff: string): number {
		let removed = 0;
		for (const [key, record] of this.#records) {
			const to = record.window?.to;
			if (!isRfc3339(to) || compareRfc3339(to, cutoff) < 0) {
				this.#records.delete(key);
				removed++;
			}
		}
		return removed;
	}

	get size(): number {
		return this.#records.size;
	}
}
