/**
 * Historical backfill — the migration counterpart to forward sync.
 *
 * Forward sync (connection.ts:pollFolder) only ever pulls NEW mail: it records
 * each folder's high-water UID and fetches `lastSeenUid+1:*` going forward. A
 * migration ("Migrate from Google") needs the OLD mail too, so this walks each
 * folder's UID space DOWN from the high-water mark to UID 1 in descending
 * batches, ingesting every message through the same `ingestMessage` path.
 *
 * The Convex side (mail/migration.ts) owns the per-folder cursor on
 * `externalMailFolderSync.backfillCursor`, so a worker restart resumes
 * mid-folder. This module is dependency-injected (no ImapFlow / Convex imports)
 * so the descending-walk logic is unit-testable; `connection.ts` wires the real
 * IMAP fetch + Convex mutations in.
 */

import type { FolderRole } from './folders.js';

export interface BackfillRange {
	/** Lowest UID in this batch (inclusive). */
	start: number;
	/** Highest UID in this batch (inclusive). */
	end: number;
}

/**
 * The next descending UID range to fetch, or null once the folder is fully
 * walked. `cursor` is the highest UID NOT yet backfilled; after fetching the
 * returned `[start, end]` the caller drops the cursor to `start - 1`.
 */
export function nextBackfillRange(cursor: number, batchSize: number): BackfillRange | null {
	if (cursor <= 0) return null;
	const size = Math.max(1, Math.floor(batchSize));
	const end = cursor;
	const start = Math.max(1, cursor - size + 1);
	return { start, end };
}

export interface BackfillFetchedMessage {
	uid: number;
	/** Raw RFC822 bytes, or null if the server returned no source. */
	source: Buffer | null;
	flags: Set<string>;
}

export interface BackfillFolderTarget {
	remoteName: string;
	role: FolderRole;
	/** Folder high-water UID (uidNext - 1) — the descending cursor's ceiling. */
	ceilingUid: number;
	/** Actual message count (mailbox.exists) — the progress denominator; IMAP
	 * UIDs are sparse so the UID ceiling overstates the count. */
	messageCount: number;
}

export interface BackfillFolderDeps {
	batchSize: number;
	/** Snapshot the ceiling/count and return the UID to start descending from,
	 * or null if there's no active migration / sync row (then skip the folder). */
	initFolder(
		remoteName: string,
		ceilingUid: number,
		messageCount: number,
	): Promise<{ startCursor: number } | null>;
	/** Fetch one UID range (inclusive) — collected fully, with no IMAP lock held
	 * during the per-message ingest that follows. Sparse UIDs ⇒ fewer than
	 * `end-start+1` results. */
	fetchBatch(remoteName: string, start: number, end: number): Promise<BackfillFetchedMessage[]>;
	/** Ingest one message (reuses the forward-sync `ingestMessage` path). */
	ingest(
		remoteName: string,
		role: FolderRole,
		uid: number,
		raw: Buffer,
		flags: Set<string>,
	): Promise<void>;
	/** Persist batch progress: cursor dropped to `newCursor`, `+importedDelta`.
	 * Returns false once the migration is no longer importing (e.g. the user hit
	 * Cancel), so the walk stops at this batch boundary instead of finishing a
	 * possibly-huge folder first. */
	recordProgress(remoteName: string, newCursor: number, importedDelta: number): Promise<boolean>;
	/** Cooperative cancellation (worker stop). */
	isStopped(): boolean;
}

/**
 * Walk one folder's history from its high-water UID down to 1 in descending
 * batches. Persists a cursor after every batch (crash-safe resume) and advances
 * the cursor past the WHOLE range even if a single message fails to ingest, so
 * one bad message never head-of-line-blocks the rest. Returns true when the
 * folder is fully walked (cursor reached 0), false if it was interrupted or has
 * no active migration.
 */
export async function backfillFolder(
	deps: BackfillFolderDeps,
	target: BackfillFolderTarget,
): Promise<boolean> {
	const init = await deps.initFolder(target.remoteName, target.ceilingUid, target.messageCount);
	if (!init) return false; // no active migration / sync row — nothing to do

	let cursor = init.startCursor;
	while (!deps.isStopped()) {
		const range = nextBackfillRange(cursor, deps.batchSize);
		if (!range) return true; // walked to UID 1 — folder done

		const messages = await deps.fetchBatch(target.remoteName, range.start, range.end);
		let imported = 0;
		for (const msg of messages) {
			if (deps.isStopped()) break;
			// A server quirk can return a UID outside the requested range — don't
			// count it against this folder's `messageCount` denominator.
			if (msg.uid < range.start || msg.uid > range.end) continue;
			if (msg.source) {
				try {
					await deps.ingest(target.remoteName, target.role, msg.uid, msg.source, msg.flags);
				} catch {
					// Skip one bad message (e.g. oversized); the cursor still advances
					// past the whole range below. The message stays on the remote server.
				}
			}
			// Count every in-range message (incl. ingest failures and source-less
			// rows the server didn't return a body for) so the percentage tracks the
			// `messageCount` denominator and reaches 100%.
			imported++;
		}

		const newCursor = range.start - 1;
		const stillImporting = await deps.recordProgress(target.remoteName, newCursor, imported);
		cursor = newCursor;
		if (!stillImporting) return false; // migration cancelled — stop promptly
	}
	return false; // interrupted
}
