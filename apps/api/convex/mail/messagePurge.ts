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

	for (const storageId of [
		message.rawStorageId,
		message.textBodyStorageId,
		message.htmlBodyStorageId,
	]) {
		if (!storageId) continue;
		try {
			await ctx.storage.delete(storageId);
		} catch {
			// Storage may already be gone — proceed to the row deletion.
		}
	}

	// The attachment index is a function of the message table; a row that
	// outlived its message would list a file that opens into nothing.
	await removeMessageAttachments(ctx, message._id);
	await ctx.db.delete(message._id);
	return message.threadId;
}
