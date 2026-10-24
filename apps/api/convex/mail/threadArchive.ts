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
 * Threads one call may archive. With the budgets below it keeps one call
 * inside a transaction's limits; a client with a longer range splits it
 * (`useInboxesThreadArchive`).
 */
const ARCHIVE_THREADS_MAX = 100;

/**
 * Messages one call moves, across all its threads. Every move pays several
 * index reads (the message and its folder, folder counters, folder
 * membership, unread-archive learning, the triage tally, thread events), about
 * seven for a plain mailbox, and a transaction may read at most 4,096 index
 * ranges. 100 leaves room for the per-thread aggregate rebuilds and provider
 * writeback of up to {@link ARCHIVE_THREADS_MAX} threads.
 */
const ARCHIVE_MOVE_BUDGET = 100;

/**
 * Inbox messages one call reads, across all its threads, moved or not
 * (snoozed mail is read and left). A conversation either budget does not
 * reach comes back unfinished, with where to resume, and the client calls
 * again until every thread is done: a whole-conversation archive must not
 * stop at a page.
 */
const ARCHIVE_SCAN_BUDGET = 2000;

/**
 * Where a thread's Inbox walk resumes: AT the first message with this
 * `receivedAt` and `_creationTime`, in `by_thread_folder_received` order.
 *
 * Inclusive because a position is not unique: many messages can share both
 * timestamps (one import writes a batch in one millisecond), and within such
 * a tie the index orders by `_id`, which a range cannot name. Starting at the
 * tie again is safe: the mail an earlier call moved has left the Inbox, so
 * all it re-reads there is snoozed mail, which it skips again. Snoozed
 * messages stay in the Inbox, so a walk that restarted from the top would
 * re-read them and could never get past a long snoozed run.
 */
const resumeFrom = v.object({ receivedAt: v.number(), creationTime: v.number() });
type ResumeFrom = Infer<typeof resumeFrom>;

type MovedMessage = Awaited<ReturnType<typeof moveMessagesToFolder>>['moved'][number];

/** How one requested conversation came out of this call. */
type ThreadOutcome = {
	threadId: Id<'mailThreads'>;
	/** Messages of this thread moved by this call. */
	moved: number;
	/** False: a budget ran out first; call again with `from`. */
	isDone: boolean;
	/** Where to resume an unfinished thread (null: from its first Inbox message). */
	from: ResumeFrom | null;
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

/**
 * A thread's Inbox messages, oldest first, from `from` on (inclusive). A
 * stream: the caller stops reading where its budget ends.
 */
async function* inboxFrom(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	inboxId: Id<'mailFolders'>,
	from: ResumeFrom | null
): AsyncGenerator<Doc<'mailMessages'>> {
	const messages = () => ctx.db.query('mailMessages');
	if (!from) {
		yield* messages().withIndex('by_thread_folder_received', (q) =>
			q.eq('threadId', threadId).eq('folderId', inboxId)
		);
		return;
	}
	// The resume position's own timestamp from its creation time on, then everything later.
	yield* messages().withIndex('by_thread_folder_received', (q) =>
		q
			.eq('threadId', threadId)
			.eq('folderId', inboxId)
			.eq('receivedAt', from.receivedAt)
			.gte('_creationTime', from.creationTime)
	);
	yield* messages().withIndex('by_thread_folder_received', (q) =>
		q.eq('threadId', threadId).eq('folderId', inboxId).gt('receivedAt', from.receivedAt)
	);
}

function positionOf(m: Doc<'mailMessages'>): ResumeFrom {
	return { receivedAt: m.receivedAt, creationTime: m._creationTime };
}

function isSamePosition(a: ResumeFrom | null, b: ResumeFrom): boolean {
	return a !== null && a.receivedAt === b.receivedAt && a.creationTime === b.creationTime;
}

// authz: every thread's mailbox passes the caller's mailbox gate before any of
// its messages are read; threads the caller cannot reach are skipped.
export const archiveThreads = postboxMutation({
	args: {
		threads: v.array(v.object({ threadId: v.id('mailThreads'), from: v.optional(resumeFrom) })),
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
		let scanLeft = ARCHIVE_SCAN_BUDGET;
		let moveLeft = ARCHIVE_MOVE_BUDGET;

		for (const request of args.threads) {
			const { threadId } = request;
			if (outcomes.has(threadId)) continue;
			const outcome: ThreadOutcome = {
				threadId,
				moved: 0,
				isDone: true,
				from: request.from ?? null,
				hasLeftInbox: false,
			};
			outcomes.set(threadId, outcome);
			if (scanLeft === 0 || moveLeft === 0) {
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

			const hadFullScan = scanLeft === ARCHIVE_SCAN_BUDGET;
			const ids: Id<'mailMessages'>[] = [];
			for await (const m of inboxFrom(ctx, threadId, inbox._id, outcome.from)) {
				if (scanLeft === 0 || moveLeft === 0) {
					// The first message this call leaves is where the next one starts.
					outcome.isDone = false;
					outcome.from = positionOf(m);
					break;
				}
				scanLeft -= 1;
				if (isMessageSnoozed(m, now)) continue;
				ids.push(m._id);
				threadOf.set(m._id, threadId);
				moveLeft -= 1;
			}
			// A whole call's reads spent on snoozed mail at the very position it
			// started from: more snoozed messages share one timestamp pair than a
			// call reads, and no call could get past them. Stop rather than
			// hand back the same position forever; the conversation stays listed.
			if (
				!outcome.isDone &&
				ids.length === 0 &&
				hadFullScan &&
				outcome.from &&
				isSamePosition(request.from ?? null, outcome.from)
			) {
				outcome.isDone = true;
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
