/**
 * Archive whole conversations: every Inbox message of each thread moves to its
 * own mailbox's Archive folder. The all-inboxes list shows one row per thread,
 * across mailboxes, so its Archive must take thread ids; `archive` takes
 * message ids of one mailbox and files them by the first one's mailbox.
 *
 * Only the Inbox copies move. Sent replies, mail already filed elsewhere and
 * snoozed messages (not in the Inbox as far as the person can see) stay where
 * they are. Each mailbox goes through the same `moveMessagesToFolder` as every
 * other archive, so counters, aggregates, the Reply Queue and provider
 * writeback match, and the per-message provenance it returns drives the same
 * move-back Undo.
 *
 * In its own module because `messageActions.ts` sits at the size cap.
 */

import { v } from 'convex/values';
import { postboxMutation } from './_helpers';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { createMailboxAccessGate } from './permissions';
import { moveMessagesToFolder } from './messageActions';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { recordTriageVerb } from './triageTally';
import { recordArchivedMoves } from './interpret/threadEvents';
import { recordUnreadArchives, unreadArchiveCandidates } from './arrival/learningSignals';

/**
 * Threads one call may archive. With the per-thread bound below it keeps one
 * call inside a transaction's write budget; a client with a longer range
 * splits it (`useInboxesThreadArchive`).
 */
const ARCHIVE_THREADS_MAX = 100;

/**
 * Inbox messages moved per thread in one call. A conversation with more Inbox
 * mail than this keeps the rest there (it stays in the list) instead of
 * failing the whole call.
 */
const ARCHIVE_THREAD_MESSAGES_MAX = 20;

type MovedMessage = Awaited<ReturnType<typeof moveMessagesToFolder>>['moved'][number];

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

// authz: every thread's mailbox passes the caller's mailbox gate before any of
// its messages are read; threads the caller cannot reach are skipped.
export const archiveThreads = postboxMutation({
	args: { threadIds: v.array(v.id('mailThreads')) },
	handler: async (ctx, args, session): Promise<{ ok: true; moved: MovedMessage[] }> => {
		if (args.threadIds.length > ARCHIVE_THREADS_MAX) {
			throwInvalidInput(`At most ${ARCHIVE_THREADS_MAX} conversations per archive`);
		}
		const access = createMailboxAccessGate(ctx, session);
		const now = Date.now();
		const inboxes = new Map<Id<'mailboxes'>, Doc<'mailFolders'> | null>();
		const byMailbox = new Map<Id<'mailboxes'>, Id<'mailMessages'>[]>();
		for (const threadId of new Set(args.threadIds)) {
			const thread = await ctx.db.get(threadId);
			if (!thread) continue;
			const owned = await access(thread.mailboxId);
			if (!owned.ok) continue;
			if (!inboxes.has(thread.mailboxId)) {
				inboxes.set(thread.mailboxId, await folderByRole(ctx, thread.mailboxId, 'inbox'));
			}
			const inbox = inboxes.get(thread.mailboxId);
			if (!inbox) continue;
			const inInbox = await ctx.db
				.query('mailMessages')
				.withIndex('by_thread_folder_received', (q) =>
					q.eq('threadId', threadId).eq('folderId', inbox._id)
				)
				.take(ARCHIVE_THREAD_MESSAGES_MAX);
			const ids = inInbox.filter((m) => !isMessageSnoozed(m, now)).map((m) => m._id);
			if (ids.length === 0) continue;
			byMailbox.set(thread.mailboxId, [...(byMailbox.get(thread.mailboxId) ?? []), ...ids]);
		}

		const moved: MovedMessage[] = [];
		for (const [mailboxId, messageIds] of byMailbox) {
			const archive = await folderByRole(ctx, mailboxId, 'archive');
			if (!archive) throwInvalidState('Archive folder missing');
			// The same bookkeeping as `archive`: unread-archive learning is read
			// before the move, the triage tally and thread events after it.
			const unread = await unreadArchiveCandidates(ctx, messageIds, archive._id);
			const result = await moveMessagesToFolder(ctx, {
				messageIds,
				targetFolderId: archive._id,
			});
			await recordTriageVerb(ctx, messageIds, 'archive');
			await recordUnreadArchives(ctx, unread, result.moved, { now });
			await recordArchivedMoves(ctx, result.moved, session.userId);
			moved.push(...result.moved);
		}
		return { ok: true, moved };
	},
});
