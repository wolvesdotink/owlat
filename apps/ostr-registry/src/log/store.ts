/**
 * SQLite storage for the embedded transparency log (plan D1: the substrate is
 * one operator's choice, the RFC 9162-shaped interface is the spec).
 *
 * This module knows rows, not log semantics: it stores the ordered leaves and
 * the published heads, and nothing derived. The Merkle tree is rebuilt from
 * `entries` on open (`SqliteRegistryLog`), so no root, no node and no proof is
 * ever read back from disk — a corrupted cache could otherwise be served as
 * history.
 *
 * `canonical` is the leaf itself: the RFC 8785 canonical text of the signed
 * attestation, `sig` included (spec 05 §5.1). It carries a UNIQUE index
 * because that is also the deduplication key a cross-submitting observer
 * relies on, and SQLite's default BINARY collation makes that comparison
 * exact rather than case- or locale-folded.
 *
 * The denormalized `observer`/`kind`/`subject_*` columns are read-side
 * indexes for the aggregator; they are copies of fields inside `canonical`,
 * which stays the only authority.
 *
 * Heads live in their own table with an AUTOINCREMENT key and a plain
 * `INSERT`, so a published head can be appended and read back but never
 * overwritten: spec 05 §5.3 requires them retained and served indefinitely.
 */
import Database from 'better-sqlite3';
import { acquireWriterLock, type WriterLock } from './writerLock.js';

type Db = Database.Database;

/** A log entry as stored: the leaf plus the coordinates the log assigned it. */
export interface StoredEntry {
	index: number;
	loggedAt: string;
	canonical: string;
}

/**
 * Everything one append writes, including the read-side index columns. The
 * index is not among them: it is assigned inside the append transaction from
 * the rows themselves, so no caller can pick one.
 */
export interface EntryInsert {
	loggedAt: string;
	canonical: string;
	leafHash: Buffer;
	observer: string;
	kind: string;
	subjectDomain: string | null;
	subjectIp: string | null;
}

/** A published head as stored: the signed JSON and the size it covers. */
export interface StoredHead {
	treeSize: number;
	serialized: string;
}

/** Bumped only for a migration; `meta.schemaVersion` records what is on disk. */
export const SCHEMA_VERSION = 1;

const SCHEMA_VERSION_KEY = 'schemaVersion';

const MIGRATION = `
CREATE TABLE IF NOT EXISTS entries (
	idx INTEGER PRIMARY KEY,
	logged_at TEXT NOT NULL,
	canonical TEXT NOT NULL,
	leaf_hash BLOB NOT NULL,
	observer TEXT NOT NULL,
	kind TEXT NOT NULL,
	subject_domain TEXT,
	subject_ip TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS entries_canonical ON entries (canonical);
CREATE INDEX IF NOT EXISTS entries_leaf_hash ON entries (leaf_hash);
CREATE INDEX IF NOT EXISTS entries_observer ON entries (observer);
CREATE INDEX IF NOT EXISTS entries_subject_domain ON entries (subject_domain);
CREATE INDEX IF NOT EXISTS entries_subject_ip ON entries (subject_ip);
CREATE TABLE IF NOT EXISTS heads (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	tree_size INTEGER NOT NULL,
	serialized TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS heads_tree_size ON heads (tree_size);
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

interface EntryRow {
	idx: number;
	logged_at: string;
	canonical: string;
}

interface HeadRow {
	tree_size: number;
	serialized: string;
}

function toStoredEntry(row: EntryRow): StoredEntry {
	return { index: row.idx, loggedAt: row.logged_at, canonical: row.canonical };
}

function toStoredHead(row: HeadRow): StoredHead {
	return { treeSize: row.tree_size, serialized: row.serialized };
}

/**
 * Refuse a database this build does not understand, *before* the migration
 * runs: `CREATE TABLE IF NOT EXISTS` against a future layout would silently
 * recreate tables a newer version renamed, and writing our version over theirs
 * would then record a downgrade that never happened.
 */
function checkSchemaVersion(db: Db): void {
	const hasMeta = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
		.pluck()
		.get();
	if (hasMeta !== 1) return;
	const stored = db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(SCHEMA_VERSION_KEY);
	if (stored === undefined || stored === null) return;
	const version = Number(stored);
	if (!Number.isSafeInteger(version) || version < 1) {
		throw new Error(`log database records an unreadable schema version: ${String(stored)}`);
	}
	if (version > SCHEMA_VERSION) {
		throw new Error(
			`log database is schema version ${version}; this build understands ${SCHEMA_VERSION}`
		);
	}
	if (version < SCHEMA_VERSION) {
		throw new Error(
			`log database is schema version ${version}; no migration to ${SCHEMA_VERSION} exists`
		);
	}
}

/**
 * The log's durable state. Every method is synchronous — better-sqlite3 is —
 * and the async surface belongs to {@link SqliteRegistryLog}, so the contract
 * never leaks the storage choice.
 *
 * Opening takes the writer lock: one process writes a log, or two histories
 * diverge (see {@link acquireWriterLock}).
 */
export class LogStore {
	private readonly db: Db;
	private readonly lock: WriterLock;
	private readonly statements: {
		insertEntry: Database.Statement<
			[number, string, string, Buffer, string, string, string | null, string | null]
		>;
		indexOfCanonical: Database.Statement<[string]>;
		indexOfLeafHash: Database.Statement<[Buffer]>;
		canonicalTexts: Database.Statement<[]>;
		range: Database.Statement<[number, number]>;
		at: Database.Statement<[number]>;
		highestIndex: Database.Statement<[]>;
		putMeta: Database.Statement<[string, string]>;
		insertHead: Database.Statement<[number, string]>;
		latestHead: Database.Statement<[]>;
		widestHead: Database.Statement<[]>;
		headAt: Database.Statement<[number]>;
		headPage: Database.Statement<[number, number]>;
	};
	/**
	 * Prepared once, as better-sqlite3 intends: a transaction function is
	 * compiled machinery, not a per-call wrapper. `immediate` takes the write
	 * lock at BEGIN, so the index this reads cannot be stale by the time it
	 * writes.
	 */
	private readonly appendTx: Database.Transaction<
		(entry: EntryInsert, expectedIndex: number) => number
	>;

	constructor(dbPath: string) {
		this.lock = acquireWriterLock(dbPath);
		try {
			this.db = new Database(dbPath);
		} catch (error) {
			this.lock.release();
			throw error;
		}
		try {
			// WAL keeps monitors tailing the log while submissions are being written;
			// NORMAL synchronous is WAL's durable-enough setting for an append-only
			// store whose losses are recoverable by re-submission.
			this.db.pragma('journal_mode = WAL');
			this.db.pragma('synchronous = NORMAL');
			checkSchemaVersion(this.db);
			this.db.exec(MIGRATION);
		} catch (error) {
			this.db.close();
			this.lock.release();
			throw error;
		}
		this.statements = {
			insertEntry: this.db.prepare(
				`INSERT INTO entries
					(idx, logged_at, canonical, leaf_hash, observer, kind, subject_domain, subject_ip)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			),
			indexOfCanonical: this.db.prepare('SELECT idx FROM entries WHERE canonical = ?').pluck(),
			indexOfLeafHash: this.db
				.prepare('SELECT idx FROM entries WHERE leaf_hash = ? ORDER BY idx LIMIT 1')
				.pluck(),
			canonicalTexts: this.db.prepare('SELECT canonical FROM entries ORDER BY idx').pluck(),
			range: this.db.prepare(
				'SELECT idx, logged_at, canonical FROM entries WHERE idx >= ? ORDER BY idx LIMIT ?'
			),
			at: this.db.prepare('SELECT idx, logged_at, canonical FROM entries WHERE idx = ?'),
			highestIndex: this.db.prepare('SELECT MAX(idx) FROM entries').pluck(),
			putMeta: this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)'),
			insertHead: this.db.prepare('INSERT INTO heads (tree_size, serialized) VALUES (?, ?)'),
			latestHead: this.db.prepare('SELECT serialized FROM heads ORDER BY seq DESC LIMIT 1').pluck(),
			widestHead: this.db.prepare(
				'SELECT tree_size, serialized FROM heads ORDER BY tree_size DESC, seq DESC LIMIT 1'
			),
			headAt: this.db
				.prepare('SELECT serialized FROM heads WHERE tree_size = ? ORDER BY seq DESC LIMIT 1')
				.pluck(),
			headPage: this.db.prepare(
				'SELECT tree_size, serialized FROM heads ORDER BY seq LIMIT ? OFFSET ?'
			),
		};
		this.appendTx = this.db.transaction((entry: EntryInsert, expectedIndex: number): number => {
			const next = (this.highestIndex() ?? -1) + 1;
			if (next !== expectedIndex) {
				throw new Error(
					`log storage and tree disagree on the next index: stored ${next}, tree ${expectedIndex}`
				);
			}
			this.statements.insertEntry.run(
				next,
				entry.loggedAt,
				entry.canonical,
				entry.leafHash,
				entry.observer,
				entry.kind,
				entry.subjectDomain,
				entry.subjectIp
			);
			return next;
		});
		this.statements.putMeta.run(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
	}

	/**
	 * Append one leaf and return the index it was given. `expectedIndex` is the
	 * caller's in-memory tree size: if the rows say something else the two views
	 * have diverged, and that is an error rather than a second history.
	 *
	 * The caller must not extend its tree until this returns — a failing COMMIT
	 * rolls the row back, and a tree holding a leaf the database does not would
	 * sign roots over evidence nobody can be shown.
	 */
	appendEntry(entry: EntryInsert, expectedIndex: number): number {
		return this.appendTx.immediate(entry, expectedIndex);
	}

	/** The index this exact leaf already occupies, or `undefined` if it is new. */
	indexOfCanonical(canonical: string): number | undefined {
		const idx = this.statements.indexOfCanonical.get(canonical);
		return typeof idx === 'number' ? idx : undefined;
	}

	/** The index of the leaf with this `sha256(0x00 || leaf)`, for spec 05 §5.4. */
	indexOfLeafHash(hash: Buffer): number | undefined {
		const idx = this.statements.indexOfLeafHash.get(hash);
		return typeof idx === 'number' ? idx : undefined;
	}

	/** Every leaf in log order — streamed, so rebuilding never holds them all. */
	*canonicalTexts(): IterableIterator<string> {
		for (const value of this.statements.canonicalTexts.iterate()) {
			yield value as string;
		}
	}

	entriesFrom(start: number, count: number): StoredEntry[] {
		if (count === 0) return [];
		return (this.statements.range.all(start, count) as EntryRow[]).map(toStoredEntry);
	}

	entryAt(index: number): StoredEntry | undefined {
		const row = this.statements.at.get(index) as EntryRow | undefined;
		return row === undefined ? undefined : toStoredEntry(row);
	}

	/** Largest stored index, or `undefined` for an empty log. */
	highestIndex(): number | undefined {
		const index = this.statements.highestIndex.get();
		return typeof index === 'number' ? index : undefined;
	}

	/**
	 * Append a published head. Heads are kept forever under a key SQLite never
	 * reuses, so a proof issued today still has its head to verify against years
	 * later (spec 05 §5.3), and no publication can land on a retained one.
	 */
	appendHead(treeSize: number, serialized: string): void {
		this.statements.insertHead.run(treeSize, serialized);
	}

	/** The most recently published head, or `undefined` before the first one. */
	latestHead(): string | undefined {
		const value = this.statements.latestHead.get();
		return typeof value === 'string' ? value : undefined;
	}

	/**
	 * The retained head covering the most leaves — the strongest commitment this
	 * database has made about its own contents, and so the one an integrity
	 * check on open has to satisfy.
	 */
	widestHead(): StoredHead | undefined {
		const row = this.statements.widestHead.get() as HeadRow | undefined;
		return row === undefined ? undefined : toStoredHead(row);
	}

	/** The newest retained head of exactly `treeSize` leaves, if one was published. */
	headAt(treeSize: number): string | undefined {
		const value = this.statements.headAt.get(treeSize);
		return typeof value === 'string' ? value : undefined;
	}

	/** Retained heads in publication order, oldest first. */
	headsFrom(offset: number, limit: number): StoredHead[] {
		if (limit === 0) return [];
		return (this.statements.headPage.all(limit, offset) as HeadRow[]).map(toStoredHead);
	}

	close(): void {
		this.db.close();
		this.lock.release();
	}
}
