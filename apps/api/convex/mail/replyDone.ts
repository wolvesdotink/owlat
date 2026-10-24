/**
 * "Send and mark done": once a reply is sent, its conversation leaves the
 * Inbox. Scheduled by the draft lifecycle's `→ sent` transition
 * (`schedule_reply_done`), so it runs only for a send that went out: an undone
 * send, a cancelled schedule or a dispatch that never reached `sent` archives
 * nothing.
 *
 * The move goes through `moveMessagesToFolder`, the bookkeeping every archive
 * shares (folder counters, thread aggregates, the Reply Queue, IMAP modseq and
 * the write-back to a connected provider).
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { canUserReadMailbox } from './permissions';
import { moveMessagesToFolder } from './messageActions';
import { recordArchivedMoves } from './interpret/threadEvents';

/** More than any conversation holds in one Inbox; the rest stays where it is. */
const MAX_ARCHIVED = 500;

/**
 * The Inbox messages of the answered conversation that "done" archives: the
 * ones that had arrived by `cutoffAt`, when the sender chose done, plus the
 * message they replied to whatever the clocks say. Mail that arrived later is
 * news the sender has not seen, so it keeps the conversation in the Inbox.
 */
export async function replyDoneCandidates(
	ctx: MutationCtx,
	args: {
		threadId: Id<'mailThreads'>;
		inboxId: Id<'mailFolders'>;
		repliedToMessageId: Id<'mailMessages'>;
		cutoffAt: number;
	}
): Promise<Id<'mailMessages'>[]> {
	const inInbox = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_folder_received', (q) =>
			q.eq('threadId', args.threadId).eq('folderId', args.inboxId)
		)
		.take(MAX_ARCHIVED);
	return inInbox
		.filter((m) => m._id === args.repliedToMessageId || m._creationTime <= args.cutoffAt)
		.map((m) => m._id);
}

export const archiveAnswered = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		threadId: v.id('mailThreads'),
		repliedToMessageId: v.id('mailMessages'),
		userId: v.string(),
		cutoffAt: v.number(),
	},
	handler: async (ctx, args): Promise<{ archived: number }> => {
		// The sender's access is checked again: it may have ended between the
		// send and now (a schedule can be days out).
		const mailbox = await ctx.db.get(args.mailboxId);
		if (!mailbox || !(await canUserReadMailbox(ctx, mailbox, args.userId))) {
			return { archived: 0 };
		}
		const thread = await ctx.db.get(args.threadId);
		if (!thread || thread.mailboxId !== args.mailboxId) return { archived: 0 };
		const folderByRole = (role: 'inbox' | 'archive') =>
			ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', args.mailboxId).eq('role', role))
				.first();
		const inbox = await folderByRole('inbox');
		const archive = await folderByRole('archive');
		if (!inbox || !archive) return { archived: 0 };

		const messageIds = await replyDoneCandidates(ctx, { ...args, inboxId: inbox._id });
		if (messageIds.length === 0) return { archived: 0 };
		const { moved } = await moveMessagesToFolder(ctx, {
			messageIds,
			targetFolderId: archive._id,
		});
		// The conversation's history says who archived it, as for any archive.
		// Not a triage signal: replying is not evidence that the sender's mail
		// should be filed away unread.
		await recordArchivedMoves(ctx, moved, args.userId);
		return { archived: moved.length };
	},
});
