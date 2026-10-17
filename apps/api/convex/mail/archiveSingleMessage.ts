/**
 * Read on arrival (SPEC §6.2, §6.4): moving ONE message of a thread, for a
 * delayed archive or a rule's folder action.
 *
 * Both go through `moveMessagesToFolder` (`messageActions.ts`): the same UID,
 * counter, aggregate and provider-writeback bookkeeping as every other move.
 * The difference is the Reply Queue. An archive normally dismisses the
 * thread's needs-reply verdict; moving one code mail out of a conversation
 * that still has mail in the Inbox must not. So the verdict is kept while
 * another message of the thread is still in the Inbox.
 *
 * In its own module rather than beside `moveMessagesToFolder` because
 * `messageActions.ts` sits at the size cap.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { moveMessagesToFolder } from './messageActions';

/** One move that happened. */
export interface SingleMove {
	sourceFolderId: Id<'mailFolders'>;
	targetFolderId: Id<'mailFolders'>;
	/** The move cleared the thread's needs-reply verdict, which undo cannot restore (§4.4). */
	isNeedsReplyCleared: boolean;
}

async function folderByRole(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	role: 'inbox' | 'archive'
): Promise<Doc<'mailFolders'> | null> {
	return await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
		.first();
}

/** Whether another message of the thread is in the Inbox: an index-backed existence proof. */
async function hasOtherInboxMessage(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	inboxId: Id<'mailFolders'>
): Promise<boolean> {
	// Two rows prove one that is not `message`, however long the thread.
	const inInbox = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_folder_received', (q) =>
			q.eq('threadId', message.threadId).eq('folderId', inboxId)
		)
		.take(2);
	return inInbox.some((row) => row._id !== message._id);
}

/**
 * Move one message into `targetFolderId` (same mailbox), keeping the thread's
 * Reply Queue state while another of its messages is still in the Inbox.
 * Null when nothing moved (gone, already there, or a foreign folder).
 */
export async function moveSingleMessage(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>,
	targetFolderId: Id<'mailFolders'>
): Promise<SingleMove | null> {
	const message = await ctx.db.get(messageId);
	if (!message || message.folderId === targetFolderId) return null;
	const target = await ctx.db.get(targetFolderId);
	if (!target || target.mailboxId !== message.mailboxId) return null;
	const inbox = await folderByRole(ctx, message.mailboxId, 'inbox');
	const isNeedsReplyKept = inbox ? await hasOtherInboxMessage(ctx, message, inbox._id) : false;
	const hadNeedsReply = (await ctx.db.get(message.threadId))?.needsReply !== undefined;
	const { moved } = await moveMessagesToFolder(
		ctx,
		{ messageIds: [messageId], targetFolderId },
		{ isNeedsReplyKept }
	);
	const row = moved[0];
	if (!row) return null;
	const hasNeedsReply = (await ctx.db.get(message.threadId))?.needsReply !== undefined;
	return {
		sourceFolderId: row.sourceFolderId,
		targetFolderId,
		isNeedsReplyCleared: hadNeedsReply && !hasNeedsReply,
	};
}

/**
 * Archive ONE message (a delayed action, §6.4): only that message moves, with
 * provider writeback, and the thread keeps its Reply Queue state while it
 * still has Inbox mail. Null when there is no Archive folder or nothing moved.
 */
export async function archiveSingleMessage(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>
): Promise<SingleMove | null> {
	const message = await ctx.db.get(messageId);
	if (!message) return null;
	const archive = await folderByRole(ctx, message.mailboxId, 'archive');
	if (!archive) return null;
	return await moveSingleMessage(ctx, messageId, archive._id);
}
