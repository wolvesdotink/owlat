/**
 * The aggregator's materialized store: scored subjects, the evidence index,
 * the persisted signed snapshot and the append-only diff feed.
 *
 * This is one operator's storage choice (plan D1), not spec — nothing outside
 * this file knows the view is SQLite. The registry log keeps its own database;
 * the aggregator owns this one, so a rebuild is `rm` plus a refresh. That is
 * also the recovery path for anything this file refuses to read back: rows are
 * shape-checked on the way out (see `./hydrate.js`), because a corrupt row that
 * reached the zone or the snapshot would be signed.
 *
 * Writes go through {@link ScoreStore.commitRefresh} as a single transaction:
 * a reader must never see half a refresh, because the DNS zone, the snapshot
 * and the HTTPS answers all have to describe the same as-of head set (spec
 * §8.1).
 *
 * That single writer is also what lets reads memoize: the view changes only at
 * `commitRefresh`, which bumps {@link ScoreStore.revision} and drops the cached
 * snapshot, so anything derived from a given revision stays valid until the next
 * one. The bulk surfaces are anonymous and served far more often than they are
 * rebuilt, and re-parsing the snapshot per request buys nothing.
 *
 * KNOWN GAP — the diff feed is not signed. Spec 08 §8.3 requires snapshots and
 * diffs to be signed and to carry the policy version and the as-of head set,
 * and `@owlat/ostr-core` defines no signed-diff envelope (`DiffFeedEntry` is a
 * bare line; only `signSnapshot` exists). Until core lands one, every diff row
 * persists the policy version and the as-of head set it was produced under —
 * {@link ScoreStore.diffPage} hands them back — so a page can be signed
 * identically after a restart the moment the envelope exists. Nothing above
 * this layer may present the feed as verifiable before then.
 */

import Database from 'better-sqlite3';
import { canonicalize } from '@owlat/ostr-core';
import type {
	DiffFeedEntry,
	SignedTreeHead,
	SnapshotEntry,
	SnapshotFile,
	Tier,
} from '@owlat/ostr-core';
import { hydrateDiffEntry, hydrateHeads, hydrateSnapshot, hydrateTier } from './hydrate.js';
import {
	DROP_ALL,
	SCHEMA,
	SCHEMA_VERSION,
	toRow,
	type DiffLineShape,
	type DiffRowShape,
	type MaterializedRow,
	type ScoreRowShape,
} from './rows.js';

export type { MaterializedRow };

/** A subject's evidence pointer: the log index, plus the inclusion time it sorts on. */
export interface EvidenceRef {
	index: number;
	loggedAt: string;
}

/** Everything one refresh writes, applied atomically. */
export interface RefreshCommit {
	/** The evaluation instant the policy ran at. */
	asOf: string;
	/**
	 * The oldest timestamp in the declared head set — what a published answer's
	 * `asof` field must carry (spec 08 §8.1), which is not the evaluation
	 * instant. Null before the first head, when there is no coverage to claim.
	 */
	headAsOf: string | null;
	/** The declared as-of head set, persisted so a diff page can name it. */
	heads: readonly SignedTreeHead[];
	rows: readonly MaterializedRow[];
	/** Subject key → evidence pointers. */
	evidence: ReadonlyMap<string, readonly EvidenceRef[]>;
	/** Subjects whose tier or score moved since the previous refresh. */
	changed: readonly { key: string; entry: SnapshotEntry }[];
	snapshot: SnapshotFile;
}

/** One diff-feed line with the context spec 08 §8.3 wants a signed page to carry. */
export interface DiffPageRow extends DiffFeedEntry {
	/** The scored subject's storage key, as the refresh that wrote the line computed it. */
	subjectKey: string;
	policy: string;
	heads: SignedTreeHead[];
}

/**
 * Rows one `diffSince` call may return. The frozen {@link ScoreIndex} signature
 * takes no limit, so the ceiling lives here rather than with the caller: an
 * anonymous client asking from `seq=0` must not be able to pull the whole feed
 * into one array and one response. A truncated page is safe for the feed's own
 * semantics — the client resumes from the last `seq` it saw.
 */
export const MAX_DIFF_PAGE = 5000;

/**
 * Diff rows kept. The feed is history rather than a view, so it is pruned by
 * age rather than rebuilt; a consumer that has fallen further behind than this
 * resyncs from the snapshot, which is the same recovery path it needs after any
 * gap. Without a bound the table grows for the life of the deployment.
 */
export const DIFF_FEED_MAX_ROWS = 200_000;

/** The page bound, applied to whatever a caller asked for. */
function pageSize(limit: number): number {
	return Math.min(Math.max(1, Math.trunc(limit)), MAX_DIFF_PAGE);
}

export interface ScoreStoreOptions {
	/** Overrides {@link DIFF_FEED_MAX_ROWS}. */
	diffFeedMaxRows?: number;
}

export class ScoreStore {
	readonly #db: Database.Database;
	readonly #diffFeedMaxRows: number;
	/**
	 * Bumped by every committed refresh. Process-local and not persisted: it
	 * identifies "the view as this instance last wrote it", which is exactly what
	 * a derived cache above this layer needs to key on.
	 */
	#revision = 0;
	/**
	 * The hydrated snapshot for the current revision; null when it has not been
	 * read since the last write. `{ value: null }` is a loaded absence — the
	 * pre-first-refresh state — and not the same thing.
	 */
	#snapshotCache: { value: SnapshotFile | null } | null = null;

	constructor(dbPath: string, options: ScoreStoreOptions = {}) {
		this.#diffFeedMaxRows = Math.max(1, Math.trunc(options.diffFeedMaxRows ?? DIFF_FEED_MAX_ROWS));
		this.#db = new Database(dbPath);
		// WAL so the HTTP layer keeps reading the previous refresh while the
		// next one writes; NORMAL sync because a lost refresh is recomputable
		// from the log by construction.
		this.#db.pragma('journal_mode = WAL');
		this.#db.pragma('synchronous = NORMAL');
		this.#migrate();
		this.#db.exec(SCHEMA);
	}

	close(): void {
		this.#db.close();
	}

	/**
	 * A counter of committed refreshes. Anything rendered from this store — the
	 * zone text above all — is valid for as long as this number does not move.
	 */
	revision(): number {
		return this.#revision;
	}

	/** Every materialized row, ordered by subject key. */
	allScores(): MaterializedRow[] {
		const rows = this.#db
			.prepare<[], ScoreRowShape>('SELECT * FROM scores ORDER BY subject_key')
			.all();
		return rows.map(toRow);
	}

	score(key: string): MaterializedRow | null {
		const row = this.#db
			.prepare<[string], ScoreRowShape>('SELECT * FROM scores WHERE subject_key = ?')
			.get(key);
		return row === undefined ? null : toRow(row);
	}

	/** Previous (tier, score) per subject key — the input to the diff feed. */
	tierAndScoreByKey(): Map<string, { tier: Tier; score: number }> {
		const rows = this.#db
			.prepare<[], Pick<ScoreRowShape, 'subject_key' | 'tier' | 'score'>>(
				'SELECT subject_key, tier, score FROM scores'
			)
			.all();
		return new Map(
			rows.map((row) => [
				row.subject_key,
				{ tier: hydrateTier(row.subject_key, row.tier), score: row.score },
			])
		);
	}

	/** A subject's evidence pointers, newest first. */
	evidence(key: string, offset: number, limit: number): number[] {
		const rows = this.#db
			.prepare<[string, number, number], { log_index: number }>(
				`SELECT log_index FROM evidence WHERE subject_key = ?
				 ORDER BY logged_at DESC, log_index DESC LIMIT ? OFFSET ?`
			)
			.all(key, limit, offset);
		return rows.map((row) => row.log_index);
	}

	/**
	 * The persisted snapshot, parsed and shape-checked once per refresh. Every
	 * caller between two refreshes gets the same object, so it must be treated as
	 * immutable — which it is: the document is signed, and re-shaping it would
	 * invalidate the signature it is served with.
	 *
	 * A corrupt document still throws on the first read after the write that
	 * produced it; the cache holds the checked value, never the raw text.
	 */
	latestSnapshot(): SnapshotFile | null {
		const cached = this.#snapshotCache;
		if (cached !== null) return cached.value;
		const row = this.#db
			.prepare<[], { document: string }>('SELECT document FROM snapshot WHERE id = 1')
			.get();
		const value = row === undefined ? null : hydrateSnapshot(row.document);
		this.#snapshotCache = { value };
		return value;
	}

	/** The evaluation instant of the persisted snapshot; null before the first refresh. */
	latestAsOf(): string | null {
		const row = this.#db
			.prepare<[], { as_of: string }>('SELECT as_of FROM snapshot WHERE id = 1')
			.get();
		return row === undefined ? null : row.as_of;
	}

	/**
	 * The as-of instant a published answer must advertise: the oldest timestamp
	 * of the declared head set (spec 08 §8.1), not the instant the policy ran.
	 * Empty before the first refresh, and equal to the evaluation instant when
	 * the refresh declared no head at all.
	 */
	zoneAsOf(): string | null {
		const row = this.#db
			.prepare<[], { head_as_of: string }>('SELECT head_as_of FROM snapshot WHERE id = 1')
			.get();
		return row === undefined ? null : row.head_as_of;
	}

	/**
	 * Diff lines after `seq`, with the policy version and as-of head set each
	 * was produced under — the inputs a signed page will need. Bounded by
	 * {@link MAX_DIFF_PAGE}.
	 *
	 * Use {@link ScoreStore.diffSince} for the published feed: this one parses
	 * and shape-checks a head set per row, which is real work to throw away.
	 */
	diffPage(seq: number, limit: number = MAX_DIFF_PAGE): DiffPageRow[] {
		const rows = this.#db
			.prepare<[number, number], DiffRowShape>(
				`SELECT seq, as_of, subject_key, entry, policy, heads FROM diff_feed
				 WHERE seq > ? ORDER BY seq LIMIT ?`
			)
			.all(seq, pageSize(limit));
		return rows.map((row) => ({
			seq: row.seq,
			asOf: row.as_of,
			subjectKey: row.subject_key,
			entry: hydrateDiffEntry(row.seq, row.entry),
			policy: row.policy,
			heads: hydrateHeads(`diff feed line ${row.seq}`, row.heads),
		}));
	}

	/**
	 * The published form of a diff page: only the columns the feed line carries.
	 * `limit` defaults to the ceiling rather than being absent, so a caller that
	 * knows it will serve 100 rows does not pay for 5000 — the query does the
	 * cutting, not the caller.
	 */
	diffSince(seq: number, limit: number = MAX_DIFF_PAGE): DiffFeedEntry[] {
		const rows = this.#db
			.prepare<[number, number], DiffLineShape>(
				`SELECT seq, as_of, entry FROM diff_feed
				 WHERE seq > ? ORDER BY seq LIMIT ?`
			)
			.all(seq, pageSize(limit));
		return rows.map((row) => ({
			seq: row.seq,
			asOf: row.as_of,
			entry: hydrateDiffEntry(row.seq, row.entry),
		}));
	}

	commitRefresh(commit: RefreshCommit): void {
		const insertScore = this.#db.prepare(
			`INSERT INTO scores (subject_key, domain, ip, tier, score, policy, explanation, as_of)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		);
		const insertEvidence = this.#db.prepare(
			'INSERT INTO evidence (subject_key, log_index, logged_at) VALUES (?, ?, ?)'
		);
		const insertDiff = this.#db.prepare(
			'INSERT INTO diff_feed (as_of, subject_key, entry, policy, heads) VALUES (?, ?, ?, ?, ?)'
		);
		const pruneDiff = this.#db.prepare(
			'DELETE FROM diff_feed WHERE seq <= (SELECT MAX(seq) FROM diff_feed) - ?'
		);
		const putSnapshot = this.#db.prepare(
			`INSERT INTO snapshot (id, as_of, head_as_of, document) VALUES (1, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				as_of = excluded.as_of,
				head_as_of = excluded.head_as_of,
				document = excluded.document`
		);

		const apply = this.#db.transaction((input: RefreshCommit) => {
			// The scored set is a view of the log, so it is replaced wholesale;
			// the diff feed and the log itself are the history.
			this.#db.exec('DELETE FROM scores; DELETE FROM evidence;');
			for (const row of input.rows) {
				insertScore.run(
					row.key,
					row.subject.domain ?? null,
					row.subject.ip ?? null,
					row.tier,
					row.score,
					row.policy,
					JSON.stringify(row.explanation),
					row.asOf
				);
				for (const ref of input.evidence.get(row.key) ?? []) {
					insertEvidence.run(row.key, ref.index, ref.loggedAt);
				}
			}
			const heads = JSON.stringify(input.heads);
			for (const change of input.changed) {
				insertDiff.run(
					input.asOf,
					change.key,
					JSON.stringify(change.entry),
					input.snapshot.policy,
					heads
				);
			}
			pruneDiff.run(this.#diffFeedMaxRows);
			// Canonical JSON, so the persisted bytes of one (log prefix, asOf)
			// are the same bytes on every aggregator that stores it.
			putSnapshot.run(input.asOf, input.headAsOf ?? input.asOf, canonicalize(input.snapshot));
		});
		apply(commit);
		// Only after the transaction returns: a refresh that rolled back left the
		// previous view in place, and its readers' caches with it.
		this.#revision += 1;
		this.#snapshotCache = null;
	}

	/**
	 * Rebuild from empty when the file was written by a different schema. The
	 * view holds nothing that is not recomputable from the log, so this is
	 * cheaper and safer than a migration ladder — and far better than the
	 * alternative, which is an `INSERT` failing against a column that is not
	 * there, halfway through a deployment.
	 */
	#migrate(): void {
		const version = this.#db.pragma('user_version', { simple: true });
		if (version === SCHEMA_VERSION) return;
		this.#db.exec(DROP_ALL);
		this.#db.pragma(`user_version = ${SCHEMA_VERSION}`);
	}
}
