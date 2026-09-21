/**
 * Single-writer enforcement for the embedded log (spec 05 §5.3).
 *
 * A Merkle log keeps its tree in memory and assigns indices from it. Two
 * processes over one database file would each hold their own tree, sequence
 * different leaves at the same index, and sign two heads of the same size over
 * different roots — equivocation, produced by a rolling restart rather than by
 * malice. SQLite would not stop it: WAL exists precisely so several
 * connections can share a file.
 *
 * So the writer takes an exclusive lock at startup and a second one fails
 * there, loudly, instead of half-way through an append. The lock is a sidecar
 * SQLite file in `locking_mode = EXCLUSIVE` rather than a lock on the log
 * itself, because the log must stay readable: monitors tail it while
 * submissions are being written, and an exclusive lock on the log would lock
 * them out too.
 *
 * The lock is an OS file lock, so a crashed process releases it — there is no
 * stale lock to clear by hand, which is the failure mode of a lock file
 * holding a PID.
 */
import Database from 'better-sqlite3';

/** A held writer lock. `release()` is idempotent. */
export interface WriterLock {
	release(): void;
}

/** Databases that cannot be shared between processes need no lock. */
function isPrivateDatabase(dbPath: string): boolean {
	return dbPath === ':memory:' || dbPath === '' || dbPath.startsWith('file::memory:');
}

function isBusy(error: unknown): boolean {
	if (typeof error !== 'object' || error === null || !('code' in error)) return false;
	const { code } = error as { code: unknown };
	return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
}

const NO_LOCK: WriterLock = { release: () => {} };

/**
 * Take the writer lock for `dbPath`, or throw if another process holds it.
 *
 * The `busy_timeout` is zero on purpose: a second writer is a deployment
 * mistake (two units enabled, an overlapping rolling restart), and waiting for
 * it to go away would only delay the report.
 */
export function acquireWriterLock(dbPath: string): WriterLock {
	if (isPrivateDatabase(dbPath)) return NO_LOCK;
	const lockPath = `${dbPath}-writer`;
	const db = new Database(lockPath);
	try {
		db.pragma('busy_timeout = 0');
		db.pragma('locking_mode = EXCLUSIVE');
		// The lock is taken on the first write, not on `locking_mode`, so the
		// table and the row are what actually claim the file.
		db.exec('CREATE TABLE IF NOT EXISTS writer (id INTEGER PRIMARY KEY)');
		db.prepare('INSERT OR REPLACE INTO writer (id) VALUES (1)').run();
	} catch (error) {
		db.close();
		if (isBusy(error)) {
			throw new Error(
				`another process is already writing this log (${lockPath} is locked): a log must have exactly one writer`
			);
		}
		throw error;
	}
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			db.close();
		},
	};
}
