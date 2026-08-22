/**
 * In-memory implementations of the two service contracts, used to drive
 * `createApp` end to end without a store, a clock or a network.
 *
 * The log fake is deliberately NOT a stub: it delegates admission to
 * `@owlat/ostr-core`'s `validateAttestation` and `verifyAttestationSignature`,
 * hashes leaves with the real Merkle tree, and signs real inclusion promises
 * and tree heads. A 422 in these tests is therefore the same 422 the real log
 * produces, and an inclusion proof served by the API verifies against the head
 * with the same `verifyInclusion` a monitor would run — which is the only way
 * a test of an HTTP layer over a transparency log means anything.
 */
import {
	canonicalBytes,
	leafHash,
	MerkleTree,
	signInclusionPromise,
	signTreeHead,
	toHex,
	validateAttestation,
	verifyAttestationSignature,
	type Attestation,
	type DiffFeedEntry,
	type ScoreResult,
	type SequencedAttestation,
	type SignedInclusionPromise,
	type SignedTreeHead,
	type SnapshotFile,
	type SubjectRef,
} from '@owlat/ostr-core';
import type { KeyDirectory, RegistryLog, ScoreIndex, SubmitOutcome } from '../../contracts.js';

/** A key directory backed by a literal map of observer domain to public keys. */
export class FakeKeyDirectory implements KeyDirectory {
	constructor(private readonly keys: ReadonlyMap<string, readonly string[]>) {}

	verifyingKeys(observerDomain: string): Promise<string[]> {
		return Promise.resolve([...(this.keys.get(observerDomain) ?? [])]);
	}
}

export const FAKE_LOG_ID = 'https://log.test/ostr';
const MMD_SECONDS = 86_400;

export class FakeRegistryLog implements RegistryLog {
	private readonly tree = new MerkleTree();
	private readonly records: SequencedAttestation[] = [];
	/** Leaf hash (hex) to index — the dedupe key, exactly as the real log's. */
	private readonly seen = new Map<string, number>();
	private publishedHead: SignedTreeHead | null = null;

	constructor(
		private readonly keys: KeyDirectory,
		private readonly privateKey: string
	) {}

	async submit(candidate: unknown, receivedAt: string): Promise<SubmitOutcome> {
		const validation = validateAttestation(candidate);
		if (!validation.ok) return { accepted: false, errors: validation.errors };
		const attestation: Attestation = validation.attestation;

		const published = await this.keys.verifyingKeys(attestation.observer);
		const verified = published.some((key) => verifyAttestationSignature(attestation, key));
		if (!verified) {
			return {
				accepted: false,
				errors: [`sig does not verify against any key published at _ostr.${attestation.observer}`],
			};
		}

		const leaf = canonicalBytes(attestation);
		const hash = toHex(leafHash(leaf));
		const existing = this.seen.get(hash);
		if (existing !== undefined) {
			return {
				accepted: true,
				index: existing,
				duplicate: true,
				promise: this.promise(hash, receivedAt),
			};
		}
		const index = this.tree.append(leaf);
		this.seen.set(hash, index);
		this.records.push({ logId: FAKE_LOG_ID, index, loggedAt: receivedAt, attestation });
		return { accepted: true, index, duplicate: false, promise: this.promise(hash, receivedAt) };
	}

	private promise(leafHashHex: string, timestamp: string): SignedInclusionPromise {
		return signInclusionPromise(
			{ logId: FAKE_LOG_ID, leafHash: leafHashHex, timestamp, mmdSeconds: MMD_SECONDS },
			this.privateKey
		);
	}

	size(): Promise<number> {
		return Promise.resolve(this.tree.size);
	}

	head(): Promise<SignedTreeHead | null> {
		return Promise.resolve(this.publishedHead);
	}

	publishHead(timestamp: string): Promise<SignedTreeHead> {
		const head = signTreeHead(
			{
				logId: FAKE_LOG_ID,
				treeSize: this.tree.size,
				rootHash: toHex(this.tree.root()),
				timestamp,
			},
			this.privateKey
		);
		this.publishedHead = head;
		return Promise.resolve(head);
	}

	/**
	 * Mirrors `SqliteRegistryLog.entries`, rejection for rejection: `start ===
	 * size` is an empty page (a monitor tailing the head), a start beyond the
	 * tree is a `RangeError`, and it arrives as a rejected promise rather than a
	 * synchronous throw so the failure mode matches the real log's too.
	 */
	async entries(start: number, count: number): Promise<SequencedAttestation[]> {
		if (!Number.isSafeInteger(start) || start < 0) {
			throw new RangeError('start must be a non-negative integer');
		}
		if (start > this.tree.size) {
			throw new RangeError(`start must be an integer in [0, ${this.tree.size}]`);
		}
		return this.records.slice(start, start + Math.max(count, 0));
	}

	/** The seam `createApp`'s `leafIndex` option is wired to in the real node. */
	indexOfLeafHash(hex: string): Promise<number | null> {
		return Promise.resolve(this.seen.get(hex) ?? null);
	}

	entry(index: number): Promise<SequencedAttestation | null> {
		return Promise.resolve(this.records[index] ?? null);
	}

	inclusionProof(index: number, treeSize: number): Promise<string[]> {
		return Promise.resolve(this.tree.inclusionProof(index, treeSize).map(toHex));
	}

	consistencyProof(oldSize: number, newSize: number): Promise<string[]> {
		return Promise.resolve(this.tree.consistencyProof(oldSize, newSize).map(toHex));
	}
}

function subjectKey(subject: SubjectRef): string {
	return `${subject.domain ?? ''}|${subject.ip ?? ''}`;
}

export interface FakeScoreIndexState {
	scores?: ReadonlyArray<ScoreResult>;
	evidence?: ReadonlyMap<string, SequencedAttestation[]>;
	snapshot?: SnapshotFile | null;
	diffs?: DiffFeedEntry[];
	zone?: string;
}

export class FakeScoreIndex implements ScoreIndex {
	private readonly scores = new Map<string, ScoreResult>();
	private readonly evidenceBySubject: ReadonlyMap<string, SequencedAttestation[]>;
	/** Mutable, so a test can move the bulk surfaces the way a refresh does. */
	private snapshotFile: SnapshotFile | null;
	private readonly diffs: DiffFeedEntry[];
	private zone: string;
	/** Recorded (subject, offset, limit) triples, so pagination can be asserted. */
	readonly evidenceCalls: Array<{ subject: SubjectRef; offset: number; limit: number }> = [];

	constructor(state: FakeScoreIndexState = {}) {
		for (const score of state.scores ?? []) this.scores.set(subjectKey(score.subject), score);
		this.evidenceBySubject = state.evidence ?? new Map();
		this.snapshotFile = state.snapshot ?? null;
		this.diffs = state.diffs ?? [];
		this.zone = state.zone ?? '';
	}

	refresh(asOf: string): Promise<{ subjects: number; asOf: string }> {
		return Promise.resolve({ subjects: this.scores.size, asOf });
	}

	score(subject: SubjectRef): Promise<ScoreResult | null> {
		return Promise.resolve(this.scores.get(subjectKey(subject)) ?? null);
	}

	evidence(subject: SubjectRef, offset: number, limit: number): Promise<SequencedAttestation[]> {
		this.evidenceCalls.push({ subject, offset, limit });
		const all = this.evidenceBySubject.get(subjectKey(subject)) ?? [];
		return Promise.resolve(all.slice(offset, offset + limit));
	}

	snapshot(): Promise<SnapshotFile | null> {
		return Promise.resolve(this.snapshotFile);
	}

	diffSince(seq: number): Promise<DiffFeedEntry[]> {
		return Promise.resolve(this.diffs.filter((entry) => entry.seq > seq));
	}

	dnsZone(): Promise<string> {
		return Promise.resolve(this.zone);
	}

	/** What a refresh does to the bulk surfaces, without a store behind it. */
	republish(next: { snapshot?: SnapshotFile | null; zone?: string }): void {
		if (next.snapshot !== undefined) this.snapshotFile = next.snapshot;
		if (next.zone !== undefined) this.zone = next.zone;
	}
}

/**
 * A score index that can bound a diff page in its own read, the way
 * `MaterializedScoreIndex` does. The plain fake deliberately does not, so both
 * branches of the route's `diffPage`-or-slice choice stay covered.
 */
export class PagedFakeScoreIndex extends FakeScoreIndex {
	/** Every (seq, limit) the route pushed down. */
	readonly pageCalls: Array<{ seq: number; limit: number }> = [];

	async diffPage(seq: number, limit: number): Promise<DiffFeedEntry[]> {
		this.pageCalls.push({ seq, limit });
		return (await this.diffSince(seq)).slice(0, limit);
	}
}

/**
 * A service pair whose every method rejects — for the 500 mapping test.
 *
 * Annotated, never cast: a `() => Promise<never>` satisfies every method on
 * both contracts structurally, so the annotation costs nothing and a contract
 * method added or renamed makes this fake fail to compile instead of silently
 * no longer implementing it.
 */
export function failingServices(err: unknown): { log: RegistryLog; scores: ScoreIndex } {
	const reject = (): Promise<never> => Promise.reject(err);
	const log: RegistryLog = {
		submit: reject,
		size: reject,
		head: reject,
		publishHead: reject,
		entries: reject,
		entry: reject,
		inclusionProof: reject,
		consistencyProof: reject,
	};
	const scores: ScoreIndex = {
		refresh: reject,
		score: reject,
		evidence: reject,
		snapshot: reject,
		diffSince: reject,
		dnsZone: reject,
	};
	return { log, scores };
}
