/**
 * "Send and mark done": once a reply is sent, its conversation leaves the
 * Inbox. Scheduled by the draft lifecycle's `→ sent` transition
 * (`schedule_reply_done`), so it runs only for a send that went out: an undone
 * send, a cancelled schedule or a dispatch that never reached `sent` archives
 * nothing.
 *
 * The move goes through `moveMessagesToFolder`, the bookkeeping every archive
 * shares (folder counters, IMAP modseq, the write-back to a connected
 * provider), with two differences a batched, delayed archive needs. The thread
 * row takes the bounded folder-only update instead of a re-read of the whole
 * conversation per batch. And the Reply Queue state is settled once, after the
 * last batch: it goes with the conversation when the Inbox is left empty, and
 * stays when newer mail (classified, or still waiting for its verdict) keeps
 * the conversation there.
 */

import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { canUserReadMailbox } from './permissions';
import { moveMessagesToFolder } from './messageActions';
import { clearThreadNeedsReply } from './needsReply';
import { recordArchivedMoves } from './interpret/threadEvents';

/**
 * Messages one run moves. A larger conversation continues in a follow-up run
 * from where this one stopped, so the archive is bounded per transaction but
 * never truncated.
 */
export const REPLY_DONE_BATCH = 200;

/**
 * One batch of the Inbox messages of the answered conversation that "done"
 * archives: the ones that had arrived by `cutoffAt`, when the sender chose
 * done. Mail that arrived later is news the sender has not seen, so it keeps
 * the conversation in the Inbox. The page walks the thread's Inbox rows from
 * `cursor`; rows it leaves behind (newer mail) are behind the next cursor, so
 * they never stall the walk.
 */
async function replyDoneBatch(
	ctx: MutationCtx,
	args: {
		threadId: Id<'mailThreads'>;
		inboxId: Id<'mailFolders'>;
		cutoffAt: number;
		cursor: string | null;
	}
): Promise<{ messageIds: Id<'mailMessages'>[]; continueCursor: string | null }> {
	const page = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_folder_received', (q) =>
			q.eq('threadId', args.threadId).eq('folderId', args.inboxId)
		)
		.paginate({ cursor: args.cursor, numItems: REPLY_DONE_BATCH });
	return {
		messageIds: page.page.filter((m) => m._creationTime <= args.cutoffAt).map((m) => m._id),
		continueCursor: page.isDone ? null : page.continueCursor,
	};
}

/**
 * The message replied to is archived whatever the clocks say, on the first run,
 * so it never depends on where it falls in the walk.
 */
async function repliedToInInbox(
	ctx: MutationCtx,
	args: {
		threadId: Id<'mailThreads'>;
		inboxId: Id<'mailFolders'>;
		repliedToMessageId: Id<'mailMessages'>;
	}
): Promise<Id<'mailMessages'>[]> {
	const message = await ctx.db.get(args.repliedToMessageId);
	return message && message.threadId === args.threadId && message.folderId === args.inboxId
		? [message._id]
		: [];
}

/**
 * After the last batch: an archive dismisses the Reply Queue state, but only
 * when the conversation left the Inbox. Mail the walk left behind (newer than
 * the cutoff, or moved back meanwhile) keeps its verdict or its pending one.
 */
async function settleReplyQueue(
	ctx: MutationCtx,
	args: { threadId: Id<'mailThreads'>; inboxId: Id<'mailFolders'> }
): Promise<void> {
	const left = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_folder_received', (q) =>
			q.eq('threadId', args.threadId).eq('folderId', args.inboxId)
		)
		.first();
	if (!left) await clearThreadNeedsReply(ctx, args.threadId);
}

export const archiveAnswered = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		threadId: v.id('mailThreads'),
		repliedToMessageId: v.id('mailMessages'),
		userId: v.string(),
		cutoffAt: v.number(),
		/** Where the previous run stopped; absent on the first run. */
		cursor: v.optional(v.string()),
		/** An earlier run of this walk moved mail. */
		hasArchived: v.optional(v.boolean()),
	},
	/** `archived`: the messages this run moved (a long conversation takes several runs). */
	handler: async (ctx, args): Promise<{ archived: number }> => {
		// The sender's access is checked again on every run: it may have ended
		// between the send and now (a schedule can be days out), or between runs.
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

		const inboxId = inbox._id;
		const batch = await replyDoneBatch(ctx, { ...args, inboxId, cursor: args.cursor ?? null });
		const first =
			args.cursor === undefined ? await repliedToInInbox(ctx, { ...args, inboxId }) : [];
		const messageIds = [...new Set([...first, ...batch.messageIds])];
		const { moved } =
			messageIds.length === 0
				? { moved: [] }
				: await moveMessagesToFolder(
						ctx,
						{ messageIds, targetFolderId: archive._id },
						{ isNeedsReplyKept: true, isFolderRolesOnly: true }
					);
		const hasArchived = args.hasArchived === true || moved.length > 0;
		if (batch.continueCursor !== null) {
			// Same cutoff, same message: the next run re-checks access and goes on.
			await ctx.scheduler.runAfter(0, internal.mail.replyDone.archiveAnswered, {
				...args,
				cursor: batch.continueCursor,
				hasArchived,
			});
		} else if (hasArchived) {
			await settleReplyQueue(ctx, { threadId: args.threadId, inboxId });
		}
		// The conversation's history says who archived it, as for any archive.
		// Not a triage signal: replying is not evidence that the sender's mail
		// should be filed away unread.
		if (moved.length > 0) await recordArchivedMoves(ctx, moved, args.userId);
		return { archived: moved.length };
	},
});
