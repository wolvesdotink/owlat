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
 * mid-folder, and the split between messages that landed and messages that did
 * not (`messagesImported` / `messagesFailed`). This module is dependency-injected (no ImapFlow / Convex imports)
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
	/**
	 * The mailbox already holds this message — recognised from its Message-ID
	 * BEFORE the body was downloaded, so `source` is deliberately null and there
	 * is nothing to ingest. It still counts as present: ingesting it would have
	 * ended in the same `duplicate` the ingest path already treats as landed.
	 */
	alreadyPresent?: boolean;
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
		messageCount: number
	): Promise<{ startCursor: number } | null>;
	/** Fetch one UID range (inclusive) — collected fully, with no IMAP lock held
	 * during the per-message ingest that follows. Sparse UIDs ⇒ fewer than
	 * `end-start+1` results. Messages the mailbox already holds may come back
	 * flagged `alreadyPresent` with no body, so a re-walk does not re-download
	 * mail that is already imported. */
	fetchBatch(remoteName: string, start: number, end: number): Promise<BackfillFetchedMessage[]>;
	/** Ingest one message (reuses the forward-sync `ingestMessage` path). Resolves
	 * false when the server stored NOTHING and the message is not already in the
	 * mailbox either — a skip the caller must not read as an import. */
	ingest(
		remoteName: string,
		role: FolderRole,
		uid: number,
		raw: Buffer,
		flags: Set<string>
	): Promise<boolean>;
	/** Report one message this walk could not store, so the failure is visible
	 * somewhere. The backfill swallowing ingest errors in silence is how an
	 * ingest that threw on EVERY message still finished as "100% imported". */
	reportIngestFailure(remoteName: string, uid: number, error: unknown): void;
	/** Persist batch progress: cursor dropped to `newCursor`, with the batch split
	 * into messages that landed and messages that did not. Returns false once the
	 * migration is no longer importing (e.g. the user hit Cancel), so the walk
	 * stops at this batch boundary instead of finishing a possibly-huge folder
	 * first. */
	recordProgress(
		remoteName: string,
		newCursor: number,
		importedDelta: number,
		failedDelta: number
	): Promise<boolean>;
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
	target: BackfillFolderTarget
): Promise<boolean> {
	const init = await deps.initFolder(target.remoteName, target.ceilingUid, target.messageCount);
	if (!init) return false; // no active migration / sync row — nothing to do

	let cursor = init.startCursor;
	while (!deps.isStopped()) {
		const range = nextBackfillRange(cursor, deps.batchSize);
		if (!range) return true; // walked to UID 1 — folder done

		const messages = await deps.fetchBatch(target.remoteName, range.start, range.end);
		let imported = 0;
		let failed = 0;
		for (const msg of messages) {
			if (deps.isStopped()) break;
			// A server quirk can return a UID outside the requested range — don't
			// count it against this folder's `messageCount` denominator.
			if (msg.uid < range.start || msg.uid > range.end) continue;
			if (msg.alreadyPresent) {
				// Skipped before the download, so the provider's bandwidth was never
				// spent on it. Counted exactly as the ingest path counts the
				// `duplicate` it would otherwise have returned, so a resumed or
				// re-walked import reports the same numbers it always did.
				imported++;
				continue;
			}
			if (!msg.source) {
				// The server listed the message but returned no body. Nothing was
				// stored, so it is not an import — but it did consume one of the
				// folder's messages, so it counts toward progress like a failure.
				failed++;
				continue;
			}
			try {
				const landed = await deps.ingest(
					target.remoteName,
					target.role,
					msg.uid,
					msg.source,
					msg.flags
				);
				// A server-side skip stores nothing and does NOT throw, so counting
				// every non-throwing ingest as an import would reopen exactly the hole
				// this split closes.
				if (landed) imported++;
				else failed++;
			} catch (error) {
				// Skip one bad message (e.g. oversized); the cursor still advances
				// past the whole range below. The message stays on the remote server.
				// It is NOT counted as imported: a run where every ingest threw has
				// to end up looking like the total failure it is, not like a
				// completed import of the same size.
				deps.reportIngestFailure(target.remoteName, msg.uid, error);
				failed++;
			}
		}

		const newCursor = range.start - 1;
		// Progress advances on `imported + failed`, so the walk still reaches the
		// folder's `messageCount` denominator and the bar still completes; the two
		// numbers stay apart on the migration row so the count of mail that
		// actually landed is the truth.
		const stillImporting = await deps.recordProgress(
			target.remoteName,
			newCursor,
			imported,
			failed
		);
		cursor = newCursor;
		if (!stillImporting) return false; // migration cancelled — stop promptly
	}
	return false; // interrupted
}
