/**
 * Done and Reopen, the conversation view's two states for a conversation.
 *
 * Done is archive underneath, so every other mail client agrees: the web
 * moves the conversation's Inbox mail to Archive through `threadArchive.ts
 * archiveThreads` and then stamps it here. The stamp is what marks a
 * conversation with nothing in the Inbox to move (one you started and are
 * waiting on), and it lapses on its own once a newer message arrives (see
 * `doneAt` in the schema). Reopen undoes both: the Archive copies go back to
 * the Inbox, read state untouched, and the stamp is cleared.
 */

import { v } from 'convex/values';
import { postboxMutation } from '../_helpers';
import type { Id } from '../../_generated/dataModel';
import { requireMailboxAccess } from '../permissions';
import { moveMessagesToFolder } from '../messageActions';
import { getOrThrow, throwForbidden, throwInvalidState } from '../../_utils/errors';

/** Archive messages one Reopen call moves back; the web calls again while `hasMore`. */
const REOPEN_PAGE = 100;

export const markDone = postboxMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args, session) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const access = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!access.ok) throwForbidden('Thread not accessible');
		const now = Date.now();
		// Never before the latest message: a clock behind the mail's would leave
		// the conversation open.
		await ctx.db.patch(thread._id, {
			doneAt: Math.max(now, thread.lastMessageAt),
			doneBy: session.userId,
			updatedAt: now,
		});
		return null;
	},
});

export const reopen = postboxMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args, session): Promise<{ hasMore: boolean }> => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const access = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!access.ok) throwForbidden('Thread not accessible');
		const [inbox, archive] = await Promise.all(
			(['inbox', 'archive'] as const).map((role) =>
				ctx.db
					.query('mailFolders')
					.withIndex('by_mailbox_and_role', (q) =>
						q.eq('mailboxId', thread.mailboxId).eq('role', role)
					)
					.first()
			)
		);
		if (!inbox) throwInvalidState('Inbox folder missing');
		const archived = archive
			? await ctx.db
					.query('mailMessages')
					.withIndex('by_thread_folder_received', (q) =>
						q.eq('threadId', thread._id).eq('folderId', archive._id)
					)
					.take(REOPEN_PAGE + 1)
			: [];
		const page = archived.slice(0, REOPEN_PAGE).map((m) => m._id as Id<'mailMessages'>);
		if (page.length > 0) {
			await moveMessagesToFolder(ctx, { messageIds: page, targetFolderId: inbox._id });
		}
		await ctx.db.patch(thread._id, { doneAt: undefined, doneBy: undefined, updatedAt: Date.now() });
		return { hasMore: archived.length > REOPEN_PAGE };
	},
});
