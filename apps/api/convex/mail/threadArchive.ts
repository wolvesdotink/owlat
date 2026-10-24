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

import { v, type Infer } from 'convex/values';
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
 * Threads one call may archive. With the scan budget below it keeps one call
 * inside a transaction's read and write budget; a client with a longer range
 * splits it (`useInboxesThreadArchive`).
 */
const ARCHIVE_THREADS_MAX = 100;

/**
 * Inbox messages one call reads (and so at most moves), across all its
 * threads. A conversation the budget does not reach comes back unfinished,
 * with where to resume, and the client calls again until every thread is
 * done: a whole-conversation archive must not stop at a page.
 */
const ARCHIVE_SCAN_BUDGET = 2000;

/** Inbox messages read per index query while walking one thread. */
const ARCHIVE_PAGE = 100;

/**
 * Where a thread's Inbox walk resumes: after this message in
 * `by_thread_folder_received` order. Snoozed messages stay in the Inbox, so a
 * walk that restarted from the top would re-read them and could never get
 * past a long snoozed run.
 */
const resumeAfter = v.object({ receivedAt: v.number(), creationTime: v.number() });
type ResumeAfter = Infer<typeof resumeAfter>;

type MovedMessage = Awaited<ReturnType<typeof moveMessagesToFolder>>['moved'][number];

/** How one requested conversation came out of this call. */
type ThreadOutcome = {
	threadId: Id<'mailThreads'>;
	/** Messages of this thread moved by this call. */
	moved: number;
	/** False: the budget ran out first; call again with `after`. */
	isDone: boolean;
	/** Where to resume an unfinished thread (null: from its first Inbox message). */
	after: ResumeAfter | null;
	/**
	 * Done and nothing of it is left in the Inbox, so the list drops it. False
	 * for a thread skipped, unreachable or still holding (snoozed) Inbox mail:
	 * the list keeps showing it.
	 */
	hasLeftInbox: boolean;
};

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

/** Up to `limit` Inbox messages of a thread, oldest first, after `after`. */
async function inboxPage(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	inboxId: Id<'mailFolders'>,
	after: ResumeAfter | null,
	limit: number
): Promise<Doc<'mailMessages'>[]> {
	const messages = () => ctx.db.query('mailMessages');
	if (!after) {
		return await messages()
			.withIndex('by_thread_folder_received', (q) =>
				q.eq('threadId', threadId).eq('folderId', inboxId)
			)
			.take(limit);
	}
	// The rest of the resume message's own timestamp, then everything later.
	const tied = await messages()
		.withIndex('by_thread_folder_received', (q) =>
			q
				.eq('threadId', threadId)
				.eq('folderId', inboxId)
				.eq('receivedAt', after.receivedAt)
				.gt('_creationTime', after.creationTime)
		)
		.take(limit);
	if (tied.length >= limit) return tied;
	const later = await messages()
		.withIndex('by_thread_folder_received', (q) =>
			q.eq('threadId', threadId).eq('folderId', inboxId).gt('receivedAt', after.receivedAt)
		)
		.take(limit - tied.length);
	return [...tied, ...later];
}

// authz: every thread's mailbox passes the caller's mailbox gate before any of
// its messages are read; threads the caller cannot reach are skipped.
export const archiveThreads = postboxMutation({
	args: {
		threads: v.array(v.object({ threadId: v.id('mailThreads'), after: v.optional(resumeAfter) })),
	},
	handler: async (
		ctx,
		args,
		session
	): Promise<{ ok: true; moved: MovedMessage[]; threads: ThreadOutcome[] }> => {
		if (args.threads.length > ARCHIVE_THREADS_MAX) {
			throwInvalidInput(`At most ${ARCHIVE_THREADS_MAX} conversations per archive`);
		}
		const access = createMailboxAccessGate(ctx, session);
		const now = Date.now();
		const inboxes = new Map<Id<'mailboxes'>, Doc<'mailFolders'> | null>();
		const byMailbox = new Map<Id<'mailboxes'>, Id<'mailMessages'>[]>();
		const outcomes = new Map<Id<'mailThreads'>, ThreadOutcome>();
		const threadOf = new Map<Id<'mailMessages'>, Id<'mailThreads'>>();
		let budget = ARCHIVE_SCAN_BUDGET;

		for (const request of args.threads) {
			const { threadId } = request;
			if (outcomes.has(threadId)) continue;
			const outcome: ThreadOutcome = {
				threadId,
				moved: 0,
				isDone: true,
				after: request.after ?? null,
				hasLeftInbox: false,
			};
			outcomes.set(threadId, outcome);
			if (budget === 0) {
				outcome.isDone = false;
				continue;
			}
			const thread = await ctx.db.get(threadId);
			if (!thread) continue;
			const owned = await access(thread.mailboxId);
			if (!owned.ok) continue;
			if (!inboxes.has(thread.mailboxId)) {
				inboxes.set(thread.mailboxId, await folderByRole(ctx, thread.mailboxId, 'inbox'));
			}
			const inbox = inboxes.get(thread.mailboxId);
			if (!inbox) continue;

			const ids: Id<'mailMessages'>[] = [];
			for (;;) {
				const limit = Math.min(ARCHIVE_PAGE, budget);
				const page = await inboxPage(ctx, threadId, inbox._id, outcome.after, limit);
				budget -= page.length;
				for (const m of page) {
					if (isMessageSnoozed(m, now)) continue;
					ids.push(m._id);
					threadOf.set(m._id, threadId);
				}
				const last = page[page.length - 1];
				if (last) outcome.after = { receivedAt: last.receivedAt, creationTime: last._creationTime };
				// A short page is the end of the thread's Inbox mail.
				if (page.length < limit) break;
				if (budget === 0) {
					outcome.isDone = false;
					break;
				}
			}
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

		for (const m of moved) {
			const threadId = threadOf.get(m.messageId);
			const outcome = threadId ? outcomes.get(threadId) : undefined;
			if (outcome) outcome.moved += 1;
		}
		// Read after the moves: `moveMessagesToFolder` has rebuilt the thread's
		// folder roles, the same field the inbox list filters on.
		for (const outcome of outcomes.values()) {
			if (!outcome.isDone || outcome.moved === 0) continue;
			const thread = await ctx.db.get(outcome.threadId);
			outcome.hasLeftInbox = !thread || !thread.folderRoles.includes('inbox');
		}
		return { ok: true, moved, threads: [...outcomes.values()] };
	},
});
