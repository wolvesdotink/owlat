/**
 * Permanent deletion of one message row, and everything that has to move with
 * it: the folder counters, the mailbox's `usedBytes`, the raw/body blobs and the
 * attachment index.
 *
 * Extracted from `messageActions.purge` (the bulk-bar's "Delete forever") so the
 * unattended trash auto-purge sweep (`mail/trashRetention.ts`) destroys mail
 * through the SAME bookkeeping. A second copy of this is how a mailbox ends up
 * with folder counts that no longer match its rows and storage nobody frees.
 *
 * Authorization is the CALLER's job: the public mutation checks mailbox access
 * per message, the sweep resolves the mailbox from the owner's settings row.
 */

import type { Id, Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { removeMessageAttachments } from './attachmentIndex';

/** The `mailMessages` columns that hold a storage blob a SIBLING row may share. */
type SharedBlobColumn = 'rawStorageId' | 'textBodyStorageId' | 'htmlBodyStorageId';

/**
 * Does any `mailMessages` row still point at `storageId` through `column`?
 *
 * One indexed `.first()` per column — the `by_*_storage` indexes exist for
 * exactly this question (see the SHARING-AWARE SEAL note in
 * `schema/mailMessages.ts`); `mail/blobReseal.ts` was their only reader.
 *
 * INVARIANT THIS RELIES ON: a storage id is referenced through exactly ONE
 * column, never two. Asking only the index matching the column the id came from
 * is sound because of that and nothing else — if some future writer pointed a
 * row's `textBodyStorageId` at another row's `rawStorageId`, purging the second
 * row would free the blob out from under the first. It holds today: every row
 * creator takes its three ids from separate `ctx.storage.store` calls
 * (`splitBodyForStorage`, `storeSealedBlob`), IMAP COPY spreads a row's ids
 * without moving one between columns, and `blobReseal` repoints per column.
 * There is no cheap way to ENFORCE it here — proving it would mean asking all
 * three indexes for all three ids, tripling the reads of a loop that runs over
 * whole mailboxes — so it is stated rather than checked. Anything that changes
 * where a blob id may live has to come back to this function.
 */
async function isBlobStillReferenced(
	ctx: MutationCtx,
	column: SharedBlobColumn,
	storageId: Id<'_storage'>
): Promise<boolean> {
	switch (column) {
		case 'rawStorageId':
			return (
				(await ctx.db
					.query('mailMessages')
					.withIndex('by_raw_storage', (q) => q.eq('rawStorageId', storageId))
					.first()) !== null
			);
		case 'textBodyStorageId':
			return (
				(await ctx.db
					.query('mailMessages')
					.withIndex('by_text_body_storage', (q) => q.eq('textBodyStorageId', storageId))
					.first()) !== null
			);
		case 'htmlBodyStorageId':
			return (
				(await ctx.db
					.query('mailMessages')
					.withIndex('by_html_body_storage', (q) => q.eq('htmlBodyStorageId', storageId))
					.first()) !== null
			);
	}
}

/**
 * Delete `message`'s row, then each of its storage blobs that NO OTHER row still
 * references. The one way to destroy a `mailMessages` row — literally: this is
 * the only `ctx.db.delete` of one in the tree, and the generic tenant wipe
 * behind `/dev/reset` special-cases the table to come through here too.
 *
 * WHY A REFCOUNT: IMAP COPY (`mail/imap/move.ts` copyMessages) inserts a second
 * row spreading the SAME `rawStorageId`/`textBodyStorageId`/`htmlBodyStorageId`,
 * so one blob can back several rows. Deleting the blob unconditionally with one
 * of them left every surviving sibling pointing at a deleted id: the message was
 * still listed, and its body and attachments were unreadable forever
 * (`readSealedBlobBytes` → `null`, `/sealed-blob` 404, IMAP `FETCH RFC822`
 * empty). `mail/blobReseal.ts` already treated the blobs as shared; the deletion
 * paths did not.
 *
 * ORDER IS LOAD-BEARING: the row goes first, and only then do we ask the index
 * whether anything is left. A Convex mutation is one serializable transaction
 * whose reads observe its own writes, so the question is asked of the state in
 * which this row is already gone — no need to special-case "except me".
 *
 * CONCURRENCY: two mutations purging sibling rows of one blob cannot both
 * conclude "I am the last", nor both conclude "someone else will". Each reads
 * the blob's `by_*_storage` range and each writes into it (its own row delete),
 * so under Convex's OCC they conflict: the one that commits second is re-run
 * against the committed state and then sees the range empty. Exactly one frees
 * the blob, and neither can free it while the other's row still points at it.
 */
export async function deleteMessageRowAndBlobs(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>
): Promise<void> {
	await ctx.db.delete(message._id);

	const blobs: ReadonlyArray<readonly [SharedBlobColumn, Id<'_storage'> | undefined]> = [
		['rawStorageId', message.rawStorageId],
		['textBodyStorageId', message.textBodyStorageId],
		['htmlBodyStorageId', message.htmlBodyStorageId],
	];
	for (const [column, storageId] of blobs) {
		if (!storageId) continue;
		if (await isBlobStillReferenced(ctx, column, storageId)) continue;
		try {
			await ctx.storage.delete(storageId);
		} catch {
			// Storage may already be gone — the row is what had to disappear.
		}
	}
}

/**
 * Delete `message` for good. Returns the thread it belonged to so the caller can
 * rebuild that thread's aggregates once per batch rather than once per message.
 */
export async function purgeMessageRow(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>
): Promise<Id<'mailThreads'>> {
	const folder = await ctx.db.get(message.folderId);
	if (folder) {
		// A snoozed unread message isn't in unseenCount; don't decrement it.
		const wasCounted = !message.flagSeen && !isMessageSnoozed(message, Date.now());
		await ctx.db.patch(folder._id, {
			totalCount: Math.max(0, folder.totalCount - 1),
			unseenCount: Math.max(0, folder.unseenCount - (wasCounted ? 1 : 0)),
			highestModseq: folder.highestModseq + 1,
			updatedAt: Date.now(),
		});
	}

	const mailbox = await ctx.db.get(message.mailboxId);
	if (mailbox) {
		await ctx.db.patch(message.mailboxId, {
			usedBytes: Math.max(0, mailbox.usedBytes - message.rawSize),
			updatedAt: Date.now(),
		});
	}

	// The attachment index is a function of the message table; a row that
	// outlived its message would list a file that opens into nothing.
	await removeMessageAttachments(ctx, message._id);
	await deleteMessageRowAndBlobs(ctx, message);
	return message.threadId;
}
