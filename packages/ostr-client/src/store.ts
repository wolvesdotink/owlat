/**
 * The local scored set: a verified snapshot plus the diff-feed entries applied
 * on top of it, indexed by subject, behind a persistence interface the caller
 * supplies (spec 08 §8.3).
 *
 * The store touches no filesystem. It reads and writes one string through
 * {@link SnapshotPersistence}, so the same class serves a node file adapter, a
 * Convex document, a browser's IndexedDB or nothing at all; keeping `fs` out of
 * the package is what lets it run in the MTA, in tests and in a worker without
 * three builds of it.
 *
 * ## Trust boundary
 *
 * A snapshot enters the scored set only after its aggregator signature has
 * verified against the configured `publicKey` — from the network, from disk,
 * and from a direct {@link SnapshotStore.adopt} call. The check lives in
 * `adopt()` itself rather than in each caller, because "every caller remembers"
 * is not a boundary.
 *
 * Diff entries carry no signature of their own in the v1 wire format, so spec
 * 08 §8.3 ("Snapshots and diffs MUST be signed ... A client MUST verify the
 * signature before use") cannot be satisfied for them. They are therefore
 * **refused by default** and require `allowUnsignedDiffs`, which drops the
 * consumer to transport-only trust for anything the feed says — see
 * {@link SnapshotStoreOptions.allowUnsignedDiffs}. Persisted diffs are dropped
 * on {@link SnapshotStore.hydrate} whenever a public key is configured, for the
 * same reason: the file's snapshot can be re-verified after a restart and its
 * diffs cannot.
 */

import {
	verifySnapshotSignature,
	type DiffFeedEntry,
	type SignedTreeHead,
	type SnapshotEntry,
	type SnapshotFile,
	type SubjectRef,
} from '@owlat/ostr-core';
import { parsePersistedSnapshot, type PersistedSnapshot } from './parse.js';
import { subjectKey, subjectLookupKeys } from './subject.js';

/**
 * Somewhere to keep one string across restarts. Both methods may reject; the
 * store reports the failure rather than throwing through a lookup path.
 */
export interface SnapshotPersistence {
	load(): Promise<string | null>;
	save(text: string): Promise<void>;
}

/** An in-memory adapter, for tests and for callers that want no durability. */
export function createMemoryPersistence(initial: string | null = null): SnapshotPersistence {
	let held = initial;
	return {
		load: () => Promise.resolve(held),
		save: (text: string) => {
			held = text;
			return Promise.resolve();
		},
	};
}

/**
 * Diff entries held on top of one snapshot, after compaction to the newest
 * entry per subject. Past this the feed is telling the consumer to take a
 * fresh snapshot, and holding more would grow memory and the persisted file
 * without bound between snapshots.
 */
export const DEFAULT_MAX_DIFF_ENTRIES = 10_000;

export interface SnapshotStoreOptions {
	persistence?: SnapshotPersistence;
	/**
	 * The aggregator's ed25519 public key, base64. Configure it: without a key
	 * the store cannot verify what {@link SnapshotStore.adopt} is handed or
	 * re-verify what {@link SnapshotStore.hydrate} reads back, and has to trust
	 * its callers and the persistence layer instead.
	 */
	publicKey?: string;
	/**
	 * Accept the unsigned v1 diff feed. **Off by default, deliberately.**
	 *
	 * A diff entry is authenticated by nothing but the transport it arrived
	 * over, so anything that can answer `/v1/diff` — a compromised aggregator,
	 * a mirror, a TLS-terminating proxy — can move any subject between tiers
	 * with no key at all. Turning this on is a decision to accept that, in
	 * exchange for freshness between snapshots; answers derived from a diff are
	 * reported with `seq !== null` so the difference stays visible downstream.
	 */
	allowUnsignedDiffs?: boolean;
	/** Cap on held diff entries. Default {@link DEFAULT_MAX_DIFF_ENTRIES}. */
	maxDiffEntries?: number;
}

/** A hit, with the instant the answer was computed at. */
export interface SnapshotLookup {
	entry: SnapshotEntry;
	/** `asOf` of the diff entry that last set it, else of the snapshot. */
	asOf: string;
	/** Diff sequence number that last set it; `null` when it came from the snapshot. */
	seq: number | null;
}

export type HydrateResult =
	| { status: 'empty' }
	| {
			status: 'loaded';
			entries: number;
			asOf: string;
			/** Persisted diff entries the store refused to re-apply unverified. */
			droppedDiffs: number;
	  }
	| { status: 'rejected'; errors: string[] };

/** The outcome of offering a snapshot to the store. */
export type AdoptResult = { ok: true; entries: number } | { ok: false; errors: string[] };

export class SnapshotStore {
	private readonly persistence: SnapshotPersistence | null;
	private readonly publicKey: string | null;
	private readonly allowUnsignedDiffs: boolean;
	private readonly maxDiffEntries: number;
	private file: SnapshotFile | null = null;
	private diffs: DiffFeedEntry[] = [];
	private index = new Map<string, SnapshotLookup>();
	private rev = 0;

	constructor(options: SnapshotStoreOptions = {}) {
		this.persistence = options.persistence ?? null;
		this.publicKey = options.publicKey ?? null;
		this.allowUnsignedDiffs = options.allowUnsignedDiffs ?? false;
		this.maxDiffEntries = options.maxDiffEntries ?? DEFAULT_MAX_DIFF_ENTRIES;
	}

	/**
	 * Read the persisted snapshot back into memory.
	 *
	 * A payload that does not parse, or whose signature does not verify against
	 * a configured public key, is `rejected` and leaves the store untouched: a
	 * corrupted or edited local file must not become the scored set.
	 *
	 * Persisted diff entries are re-applied only when the store has no public
	 * key — the case where it is already trusting the persistence layer for the
	 * snapshot too — and unsigned diffs are allowed. With a key configured they
	 * are counted in `droppedDiffs` and discarded, because appending a line to
	 * the local file would otherwise move a subject between tiers with no
	 * signature anywhere in the path. The cursor restarts at the snapshot and
	 * the feed re-supplies them.
	 */
	async hydrate(): Promise<HydrateResult> {
		if (this.persistence === null) return { status: 'empty' };
		let text: string | null;
		try {
			text = await this.persistence.load();
		} catch (error: unknown) {
			return { status: 'rejected', errors: [`load failed: ${messageOf(error)}`] };
		}
		if (text === null || text.length === 0) return { status: 'empty' };
		const parsed = parsePersistedSnapshot(text);
		if (parsed === null) {
			return {
				status: 'rejected',
				errors: ['persisted snapshot is not a valid snapshot document'],
			};
		}
		if (this.publicKey !== null && !verifySnapshotSignature(parsed.snapshot, this.publicKey)) {
			return { status: 'rejected', errors: ['persisted snapshot signature did not verify'] };
		}
		const trustPersistedDiffs = this.publicKey === null && this.allowUnsignedDiffs;
		const droppedDiffs = trustPersistedDiffs ? 0 : parsed.diffs.length;
		this.load(trustPersistedDiffs ? parsed : { ...parsed, diffs: [] });
		return {
			status: 'loaded',
			entries: this.index.size,
			asOf: this.asOf() ?? parsed.snapshot.asOf,
			droppedDiffs,
		};
	}

	/**
	 * Verify `snapshot` against the configured public key and, on success,
	 * replace the scored set with it — dropping every previously applied diff,
	 * which described the state between the old snapshot and this one.
	 *
	 * With no key configured the signature cannot be checked and the snapshot is
	 * taken on the caller's word; that is what constructing the store without
	 * `publicKey` means.
	 */
	async adopt(snapshot: SnapshotFile): Promise<AdoptResult> {
		if (this.publicKey !== null && !verifySnapshotSignature(snapshot, this.publicKey)) {
			return { ok: false, errors: ['snapshot signature did not verify'] };
		}
		this.load({ v: 1, snapshot, diffs: [] });
		await this.persist();
		return { ok: true, entries: this.index.size };
	}

	/**
	 * Apply diff-feed entries on top of the current snapshot, ascending by
	 * `seq`, skipping anything already applied. Returns the number applied.
	 *
	 * Throws — rather than quietly applying or quietly ignoring — when the
	 * store has no snapshot, when unsigned diffs were not opted into, or when
	 * the feed is larger than the store is willing to hold. All three are
	 * conditions under which the caller's scored set would stop meaning what it
	 * says, so they are reported, not absorbed.
	 */
	async applyDiffs(entries: readonly DiffFeedEntry[]): Promise<number> {
		if (this.file === null) throw new Error('no snapshot to apply diffs to');
		if (!this.allowUnsignedDiffs) {
			throw new Error(
				'unsigned diff entries refused: set allowUnsignedDiffs to accept transport-only trust (spec 08 §8.3)'
			);
		}
		const pending = [...entries]
			.filter((entry) => entry.seq > this.latestSeq())
			.sort((a, b) => a.seq - b.seq);
		if (pending.length > this.maxDiffEntries) {
			throw new Error(
				`diff feed of ${pending.length} entries exceeds maxDiffEntries=${this.maxDiffEntries}; take a fresh snapshot`
			);
		}
		if (pending.length === 0) return 0;

		const held = compactDiffs([...this.diffs, ...pending]);
		if (held.length > this.maxDiffEntries) {
			throw new Error(
				`applying ${pending.length} entries would hold ${held.length} diffs, over maxDiffEntries=${this.maxDiffEntries}; take a fresh snapshot`
			);
		}
		this.diffs = held;
		for (const entry of pending) this.put(entry.entry, entry.asOf, entry.seq);
		this.rev += 1;
		await this.persist();
		return pending.length;
	}

	/** The scored entry for `subject`, or `null` on a miss. */
	tier(subject: SubjectRef): SnapshotEntry | null {
		return this.lookup(subject)?.entry ?? null;
	}

	/** As {@link tier}, plus the `asOf` and diff sequence behind the answer. */
	lookup(subject: SubjectRef): SnapshotLookup | null {
		for (const key of subjectLookupKeys(subject)) {
			const found = this.index.get(key);
			if (found !== undefined) return found;
		}
		return null;
	}

	/** The verified snapshot the local set is built from, before diffs. */
	snapshot(): SnapshotFile | null {
		return this.file;
	}

	/** Policy version the snapshot was scored under, e.g. `ostr-policy-v1`. */
	policy(): string | null {
		return this.file?.policy ?? null;
	}

	/** The as-of head set the snapshot was scored against (spec 08 §8.3). */
	heads(): SignedTreeHead[] {
		return this.file === null ? [] : [...this.file.heads];
	}

	/**
	 * The **oldest** head timestamp in the as-of set, which is the instant up to
	 * which every trusted log has been accounted for — the `asof` rule of spec
	 * 08 §8.1. `null` before a snapshot is loaded.
	 */
	headsAsOf(): string | null {
		let oldest: string | null = null;
		for (const head of this.file?.heads ?? []) {
			if (oldest === null || isBefore(head.timestamp, oldest)) oldest = head.timestamp;
		}
		return oldest;
	}

	/** The newest `asOf` the local set carries: the last diff's, else the snapshot's. */
	asOf(): string | null {
		const last = this.diffs[this.diffs.length - 1];
		if (last !== undefined) return last.asOf;
		return this.file?.asOf ?? null;
	}

	/** Highest diff sequence applied; `0` when only the snapshot is loaded. */
	latestSeq(): number {
		return this.diffs[this.diffs.length - 1]?.seq ?? 0;
	}

	/** Number of distinct subjects the local set scores. */
	size(): number {
		return this.index.size;
	}

	/** True when the store was opted into the unsigned v1 diff feed. */
	acceptsUnsignedDiffs(): boolean {
		return this.allowUnsignedDiffs;
	}

	/**
	 * True when a public key is configured, i.e. when a snapshot in this store
	 * has had its aggregator signature checked. A consumer surfacing "verified"
	 * to an operator reads this, rather than assuming.
	 */
	verifiesSnapshots(): boolean {
		return this.publicKey !== null;
	}

	/**
	 * Bumped every time the scored set changes. A cache in front of the store
	 * compares it before serving a hit, so a caller that reaches past the
	 * facade — `client.snapshotStore().adopt(...)` — cannot leave stale answers
	 * being served until a TTL runs out.
	 */
	revision(): number {
		return this.rev;
	}

	/** Write the current state through the persistence adapter, if there is one. */
	async persist(): Promise<void> {
		if (this.persistence === null || this.file === null) return;
		const document: PersistedSnapshot = { v: 1, snapshot: this.file, diffs: this.diffs };
		await this.persistence.save(JSON.stringify(document));
	}

	private load(document: PersistedSnapshot): void {
		this.file = document.snapshot;
		this.diffs = [];
		this.index = new Map();
		this.rev += 1;
		for (const entry of document.snapshot.entries) this.put(entry, document.snapshot.asOf, null);
		for (const diff of compactDiffs(document.diffs)) {
			this.diffs.push(diff);
			this.put(diff.entry, diff.asOf, diff.seq);
		}
	}

	private put(entry: SnapshotEntry, asOf: string, seq: number | null): void {
		const key = subjectKey(entry.subject);
		if (key === null) return;
		this.index.set(key, { entry, asOf, seq });
	}
}

/**
 * The smallest set of entries that reconstructs the same state: the newest
 * entry per subject, in ascending `seq`.
 *
 * Superseded entries for a subject say nothing the newer one does not, and the
 * highest-sequence entry is always the newest for *its* subject, so compaction
 * preserves both `latestSeq()` and `asOf()`. Without it the array grows for the
 * lifetime of a snapshot and is re-serialized whole on every persist.
 */
function compactDiffs(entries: readonly DiffFeedEntry[]): DiffFeedEntry[] {
	const newest = new Map<string, DiffFeedEntry>();
	// Entries naming no scoreable subject can never be looked up; only the
	// newest is kept, and only so that it can still carry the cursor.
	let unkeyed: DiffFeedEntry | null = null;
	for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
		const key = subjectKey(entry.entry.subject);
		if (key === null) unkeyed = entry;
		else newest.set(key, entry);
	}
	const held = [...newest.values()];
	if (unkeyed !== null) held.push(unkeyed);
	return held.sort((a, b) => a.seq - b.seq);
}

/** RFC 3339 comparison, falling back to lexicographic order for odd input. */
function isBefore(candidate: string, incumbent: string): boolean {
	const a = Date.parse(candidate);
	const b = Date.parse(incumbent);
	if (Number.isNaN(a) || Number.isNaN(b)) return candidate < incumbent;
	return a < b;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
