/**
 * The registry node's embedded transparency log (plan §4.1, §9.1, D1;
 * spec 05).
 *
 * Content-neutral by construction: a submission is admitted on FORM and
 * SIGNATURE only — structural validity per `validateAttestation`, and an
 * ed25519 signature by a key the observer publishes at `_ostr.<observer>`.
 * Nothing here looks at whether a claim is plausible, whether the observer is
 * reputable or whether the counts are large. Suspicion is a monitor's job, on
 * the record, as an `audit-finding`.
 *
 * The leaf is the RFC 8785 canonical form of the whole signed attestation,
 * `sig` included (spec 05 §5.1), so the bytes committed to are exactly the
 * bytes any verifier can recompute from the served entry.
 *
 * Determinism: every timestamp is an argument. This module never reads a
 * clock, so a replay of the same submissions produces the same tree, the same
 * promises and the same heads.
 */
import {
	type Attestation,
	canonicalBytes,
	isRfc3339,
	leafHash,
	MerkleTree,
	parseHash,
	parseOstrKeyRecord,
	selectVerifyingKey,
	type SequencedAttestation,
	signInclusionPromise,
	type SignedInclusionPromise,
	signTreeHead,
	type SignedTreeHead,
	toHex,
	validateAttestation,
} from '@owlat/ostr-core';
import type { KeyDirectory, RegistryLog, SubmitOutcome } from '../contracts.js';
import { LogStore } from './store.js';

/** Illustrative default MMD of spec 05 §5.2: 24 hours. */
export const DEFAULT_MMD_SECONDS = 86_400;

/**
 * Ceiling on one page of leaves. The HTTP layer has its own, smaller page
 * limit; this one is defense in depth for every other caller — an import job,
 * an operator tool — so no single call can materialize the whole tree.
 */
export const MAX_ENTRIES_PAGE = 1000;

export interface SqliteRegistryLogOptions {
	/** SQLite file; `:memory:` for an ephemeral log. */
	dbPath: string;
	/** This log's stable ID — signed into every head and promise. */
	logId: string;
	/** Raw 32-byte ed25519 private key, base64: the log's signing key. */
	privateKeyBase64: string;
	/** Resolves an observer's published verifying keys (`_ostr.<domain>` TXT). */
	keys: KeyDirectory;
	/** Published maximum merge delay in seconds. */
	mmdSeconds?: number;
}

/**
 * RFC 3339 UTC instants only: one instant gets exactly one spelling, and it is
 * `@owlat/ostr-core`'s spelling. The signed documents this module produces
 * enforce the same predicate, so a second definition here could only drift
 * from it — and a weaker one (`2026-02-31T25:99:99Z`) would push the failure
 * down into the signer.
 */
function requireUtcInstant(name: string, value: string): void {
	if (!isRfc3339(value)) {
		throw new RangeError(`${name} must be an RFC 3339 UTC instant ending in Z`);
	}
}

function requireCounter(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative integer`);
	}
}

function parseHead(serialized: string): SignedTreeHead {
	return JSON.parse(serialized) as SignedTreeHead;
}

/**
 * Append-only Merkle log over SQLite. The tree lives in memory and is rebuilt
 * from the stored leaves on open; the database holds leaves and published
 * heads and nothing derived.
 */
export class SqliteRegistryLog implements RegistryLog {
	private readonly store: LogStore;
	private readonly tree: MerkleTree;
	private readonly logId: string;
	private readonly privateKeyBase64: string;
	private readonly keys: KeyDirectory;
	/** Published maximum merge delay; every promise states it. */
	readonly mmdSeconds: number;

	constructor(options: SqliteRegistryLogOptions) {
		this.logId = options.logId;
		this.privateKeyBase64 = options.privateKeyBase64;
		this.keys = options.keys;
		this.mmdSeconds = options.mmdSeconds ?? DEFAULT_MMD_SECONDS;
		if (!Number.isSafeInteger(this.mmdSeconds) || this.mmdSeconds <= 0) {
			throw new RangeError('mmdSeconds must be a positive integer');
		}
		this.store = new LogStore(options.dbPath);
		this.tree = new MerkleTree();
		try {
			for (const canonical of this.store.canonicalTexts()) {
				this.tree.append(Buffer.from(canonical, 'utf8'));
			}
			this.requireContiguousIndices();
			this.requireHeadsStillHold();
		} catch (error) {
			this.store.close();
			throw error;
		}
	}

	/**
	 * Validate, verify, dedupe and append. `receivedAt` is the log's clock.
	 *
	 * Rejections carry the validator's own messages, or exactly one of
	 * `unknown observer key` (the observer publishes no usable key) and
	 * `bad signature` (it publishes keys, none of which signed this document).
	 * A submission whose bytes are already in the tree is answered with the
	 * index it already occupies and a freshly signed promise: cross-submission
	 * and retries must be idempotent, not duplicated evidence (spec 05 §5.5).
	 */
	async submit(candidate: unknown, receivedAt: string): Promise<SubmitOutcome> {
		requireUtcInstant('receivedAt', receivedAt);
		const validation = validateAttestation(candidate);
		if (!validation.ok) return { accepted: false, errors: validation.errors };

		const attestation = validation.attestation;
		const leaf = canonicalBytes(attestation);
		const canonical = leaf.toString('utf8');

		// Dedupe before the key lookup, which is DNS in production. These exact
		// bytes were validated and signature-verified when they were first
		// accepted, and the leaf is already in the tree, so the answer cannot
		// change — while looking the observer up anyway would let anyone replay
		// one captured attestation into a query flood at a third party's
		// nameservers. Submission is open to the world; it must not be a lever.
		const known = this.store.indexOfCanonical(canonical);
		if (known !== undefined) {
			return {
				accepted: true,
				index: known,
				promise: this.promiseFor(leaf, receivedAt),
				duplicate: true,
			};
		}

		const rejection = await this.signatureRejection(attestation);
		if (rejection !== null) return { accepted: false, errors: [rejection] };

		// The lookup above was the last `await`: from here the dedupe re-check and
		// the append are one synchronous section, so of two in-flight submissions
		// of the same new bytes exactly one appends and the other sees the leaf.
		const existing = this.store.indexOfCanonical(canonical);
		const promise = this.promiseFor(leaf, receivedAt);
		if (existing !== undefined) {
			return { accepted: true, index: existing, promise, duplicate: true };
		}
		const index = this.append(attestation, canonical, leaf, receivedAt);
		return { accepted: true, index, promise, duplicate: false };
	}

	async size(): Promise<number> {
		return this.tree.size;
	}

	async head(): Promise<SignedTreeHead | null> {
		const serialized = this.store.latestHead();
		if (serialized === undefined) return null;
		return parseHead(serialized);
	}

	/**
	 * Sign and persist a head over the current size. Publishing with nothing
	 * new appended is legal and required: silence must be distinguishable from
	 * a stalled log (spec 05 §5.3). The root is always recomputed from the
	 * leaves, so two heads of one size can never disagree.
	 */
	async publishHead(timestamp: string): Promise<SignedTreeHead> {
		requireUtcInstant('timestamp', timestamp);
		const treeSize = this.tree.size;
		const head = signTreeHead(
			{
				logId: this.logId,
				treeSize,
				rootHash: toHex(this.tree.root(treeSize)),
				timestamp,
			},
			this.privateKeyBase64
		);
		this.store.appendHead(treeSize, JSON.stringify(head));
		return head;
	}

	/**
	 * A retained head of exactly `treeSize` leaves, newest first when the log
	 * published several. Spec 05 §5.3 keeps heads forever so a proof issued
	 * today still verifies years later; that is only true if the head it
	 * verifies against can still be fetched.
	 */
	async headAt(treeSize: number): Promise<SignedTreeHead | null> {
		requireCounter('treeSize', treeSize);
		const serialized = this.store.headAt(treeSize);
		return serialized === undefined ? null : parseHead(serialized);
	}

	/** Retained heads in publication order, oldest first. */
	async heads(offset: number, limit: number): Promise<SignedTreeHead[]> {
		requireCounter('offset', offset);
		requireCounter('limit', limit);
		return this.store
			.headsFrom(offset, Math.min(limit, MAX_ENTRIES_PAGE))
			.map((row) => parseHead(row.serialized));
	}

	/**
	 * Leaves in log order from `start`. `start === size` answers empty — a
	 * monitor tailing the head asks for entries that do not exist yet — while
	 * a start beyond the tree is a range error. `count` is clamped to
	 * {@link MAX_ENTRIES_PAGE}, as a page is, not rejected.
	 */
	async entries(start: number, count: number): Promise<SequencedAttestation[]> {
		requireCounter('start', start);
		requireCounter('count', count);
		const size = this.tree.size;
		if (start > size) {
			throw new RangeError(`start must be an integer in [0, ${size}]`);
		}
		return this.store.entriesFrom(start, Math.min(count, MAX_ENTRIES_PAGE)).map((entry) => ({
			logId: this.logId,
			index: entry.index,
			loggedAt: entry.loggedAt,
			attestation: JSON.parse(entry.canonical) as Attestation,
		}));
	}

	async entry(index: number): Promise<SequencedAttestation | null> {
		requireCounter('index', index);
		const stored = this.store.entryAt(index);
		if (stored === undefined) return null;
		return {
			logId: this.logId,
			index: stored.index,
			loggedAt: stored.loggedAt,
			attestation: JSON.parse(stored.canonical) as Attestation,
		};
	}

	/**
	 * The index of the leaf with this hash (`sha256(0x00 || leaf)`, lowercase
	 * hex), or `null`. Spec 05 §5.4 asks for inclusion proofs by leaf hash: a
	 * verifier holding an inclusion promise knows the hash and nothing else.
	 */
	async indexOfLeafHash(hashHex: string): Promise<number | null> {
		const hash = parseHash(hashHex);
		if (hash === undefined) return null;
		return this.store.indexOfLeafHash(hash) ?? null;
	}

	/**
	 * RFC 6962 §2.1.1 audit path for `index` against the tree of `treeSize`
	 * leaves, hex-encoded. Out-of-range coordinates throw `RangeError`; the
	 * HTTP layer maps that to a 400.
	 */
	async inclusionProof(index: number, treeSize: number): Promise<string[]> {
		return this.tree.inclusionProof(index, treeSize).map((hash) => toHex(hash));
	}

	/** RFC 6962 §2.1.2 consistency proof, hex-encoded. */
	async consistencyProof(oldSize: number, newSize: number): Promise<string[]> {
		return this.tree.consistencyProof(oldSize, newSize).map((hash) => toHex(hash));
	}

	/** Release the database handle and the writer lock. */
	close(): void {
		this.store.close();
	}

	/**
	 * Indices are permanent and dense (spec 05 §5.1). A gap means the file was
	 * edited or truncated, and every proof served from the rebuilt tree would
	 * silently place leaves at indices they were never sequenced at.
	 */
	private requireContiguousIndices(): void {
		const highest = this.store.highestIndex();
		if (highest !== undefined && highest !== this.tree.size - 1) {
			throw new Error(
				`log database is not contiguous: ${this.tree.size} leaves with highest index ${highest}`
			);
		}
	}

	/**
	 * The rebuilt tree must still produce the roots this log already signed.
	 *
	 * Without this check, editing a leaf in place or dropping the last rows is
	 * invisible on open: the indices stay dense, the log re-sequences different
	 * leaves and signs a second head of a size it has already published, with a
	 * different root. That is equivocation — spec 05 §5.3's one unforgivable
	 * act — committed by a restart. Refusing to open is the only safe answer:
	 * a log that cannot reproduce its own history has nothing to serve.
	 *
	 * The widest retained head is enough. A Merkle root over `n` leaves fixes
	 * every leaf below `n`, so reproducing it reproduces every narrower head
	 * too. (Truncation of leaves no head has covered yet is undetectable here
	 * by construction: nothing was ever promised about them.)
	 */
	private requireHeadsStillHold(): void {
		const stored = this.store.widestHead();
		if (stored === undefined) return;
		// The size is taken from the signed document, not from the column the
		// query sorts on: the column is an index, and an index is not evidence.
		const head = parseHead(stored.serialized);
		const committed = head.treeSize;
		if (!Number.isSafeInteger(committed) || committed < 0 || committed !== stored.treeSize) {
			throw new Error(
				`log database holds a malformed head: signed size ${String(committed)}, stored size ${stored.treeSize}`
			);
		}
		if (this.tree.size < committed) {
			throw new Error(
				`log database is short of its published head: ${this.tree.size} leaves under a head of ${committed}`
			);
		}
		const recomputed = toHex(this.tree.root(committed));
		if (recomputed !== head.rootHash) {
			throw new Error(
				`log database contradicts its published head at size ${committed}: recomputed root ${recomputed}, published ${String(head.rootHash)}`
			);
		}
	}

	/**
	 * `null` when the attestation is signed by a key the observer publishes.
	 * The two failures are kept apart because they mean different things to a
	 * submitter: a missing key record is a DNS problem it can fix, a failing
	 * signature is a signing problem.
	 */
	private async signatureRejection(attestation: Attestation): Promise<string | null> {
		const records = await this.keys.verifyingKeys(attestation.observer);
		const usable = records.filter((record) => parseOstrKeyRecord(record).ok);
		if (usable.length === 0) return 'unknown observer key';
		return selectVerifyingKey(usable, attestation) === null ? 'bad signature' : null;
	}

	private promiseFor(leaf: Buffer, timestamp: string): SignedInclusionPromise {
		return signInclusionPromise(
			{
				logId: this.logId,
				leafHash: toHex(leafHash(leaf)),
				timestamp,
				mmdSeconds: this.mmdSeconds,
			},
			this.privateKeyBase64
		);
	}

	/**
	 * The row lands first and the tree follows: a failing COMMIT (disk full, an
	 * I/O error) must not leave the in-memory tree holding a leaf that was
	 * never persisted, because every head signed afterwards would commit to
	 * evidence nobody can be served — and the next open would refuse.
	 */
	private append(
		attestation: Attestation,
		canonical: string,
		leaf: Buffer,
		loggedAt: string
	): number {
		const index = this.store.appendEntry(
			{
				loggedAt,
				canonical,
				leafHash: leafHash(leaf),
				observer: attestation.observer,
				kind: attestation.kind,
				subjectDomain: attestation.subject.domain ?? null,
				subjectIp: attestation.subject.ip ?? null,
			},
			this.tree.size
		);
		this.tree.append(leaf);
		return index;
	}
}
