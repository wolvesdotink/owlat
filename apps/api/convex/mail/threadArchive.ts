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
 * (snoozed mail is read and left). A conversation the budgets do not reach
 * comes back unfinished and the client calls again until every thread is
 * done: a whole-conversation archive must not stop at a page.
 */
const ARCHIVE_SCAN_BUDGET = 2000;

/**
 * Messages the first conversation of a call reads: one page. No larger than
 * the move budget, so a page never holds more mail than the call may move
 * and its cursor is never left behind mail it could not move.
 */
const ARCHIVE_PAGE_SIZE = ARCHIVE_MOVE_BUDGET;

type MovedMessage = Awaited<ReturnType<typeof moveMessagesToFolder>>['moved'][number];

/** How one requested conversation came out of this call. */
type ThreadOutcome = {
	threadId: Id<'mailThreads'>;
	/** Messages of this thread moved by this call. */
	moved: number;
	/** False: a budget ran out first; call again, this thread first, with `cursor`. */
	isDone: boolean;
	/** Where an unfinished thread resumes (null: from its first Inbox message). */
	cursor: string | null;
	/**
	 * Done and nothing of it is left in the Inbox, so the list drops it. False
	 * for a thread skipped, unreachable or still holding (snoozed) Inbox mail:
	 * the list keeps showing it.
	 */
	hasLeftInbox: boolean;
};

/** What a walk of one thread's Inbox found: the mail to move and how many messages it read. */
type Walk = { eligible: Id<'mailMessages'>[]; read: number };

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

function threadInbox(ctx: MutationCtx, threadId: Id<'mailThreads'>, inboxId: Id<'mailFolders'>) {
	return ctx.db
		.query('mailMessages')
		.withIndex('by_thread_folder_received', (q) =>
			q.eq('threadId', threadId).eq('folderId', inboxId)
		);
}

/**
 * The call's first conversation: one page from its cursor. A pagination
 * cursor names an exact index position, `_id` included, so a resumed walk
 * neither skips nor re-reads mail however many messages share both
 * timestamps, and every call moves the cursor on, even through snoozed mail
 * (which stays in the Inbox). A function may paginate only once, so only the
 * first conversation of a call walks this way.
 */
async function walkPage(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	inboxId: Id<'mailFolders'>,
	cursor: string | null,
	now: number
): Promise<Walk & { isDone: boolean; cursor: string | null }> {
	const page = await threadInbox(ctx, threadId, inboxId).paginate({
		cursor,
		numItems: ARCHIVE_PAGE_SIZE,
	});
	return {
		eligible: page.page.filter((m) => !isMessageSnoozed(m, now)).map((m) => m._id),
		read: page.page.length,
		isDone: page.isDone,
		cursor: page.isDone ? null : page.continueCursor,
	};
}

/**
 * Any later conversation: streamed whole within what the call has left, or
 * null when it does not fit. Then none of it moves in this call: it comes
 * back unfinished without a cursor, leads the next call and is paged there.
 */
async function walkWhole(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	inboxId: Id<'mailFolders'>,
	now: number,
	left: { scan: number; move: number }
): Promise<Walk | null> {
	const walk: Walk = { eligible: [], read: 0 };
	for await (const m of threadInbox(ctx, threadId, inboxId)) {
		if (walk.read === left.scan || walk.eligible.length === left.move) return null;
		walk.read += 1;
		if (!isMessageSnoozed(m, now)) walk.eligible.push(m._id);
	}
	return walk;
}

// authz: every thread's mailbox passes the caller's mailbox gate before any of
// its messages are read; threads the caller cannot reach are skipped.
export const archiveThreads = postboxMutation({
	args: {
		/** Only the first may carry a `cursor`: the one conversation a call pages. */
		threads: v.array(v.object({ threadId: v.id('mailThreads'), cursor: v.optional(v.string()) })),
	},
	handler: async (
		ctx,
		args,
		session
	): Promise<{ ok: true; moved: MovedMessage[]; threads: ThreadOutcome[] }> => {
		if (args.threads.length > ARCHIVE_THREADS_MAX) {
			throwInvalidInput(`At most ${ARCHIVE_THREADS_MAX} conversations per archive`);
		}
		if (args.threads.some((request, index) => index > 0 && request.cursor !== undefined)) {
			throwInvalidInput('Only the first conversation of an archive resumes from a cursor');
		}
		const access = createMailboxAccessGate(ctx, session);
		const now = Date.now();
		const inboxes = new Map<Id<'mailboxes'>, Doc<'mailFolders'> | null>();
		const byMailbox = new Map<Id<'mailboxes'>, Id<'mailMessages'>[]>();
		const outcomes = new Map<Id<'mailThreads'>, ThreadOutcome>();
		const reached = new Set<Id<'mailThreads'>>();
		const threadOf = new Map<Id<'mailMessages'>, Id<'mailThreads'>>();
		const left = { scan: ARCHIVE_SCAN_BUDGET, move: ARCHIVE_MOVE_BUDGET };
		let isSpent = false;

		for (const [index, request] of args.threads.entries()) {
			const { threadId } = request;
			if (outcomes.has(threadId)) continue;
			const outcome: ThreadOutcome = {
				threadId,
				moved: 0,
				isDone: true,
				cursor: request.cursor ?? null,
				hasLeftInbox: false,
			};
			outcomes.set(threadId, outcome);
			if (isSpent || left.scan === 0 || left.move === 0) {
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
			reached.add(threadId);

			let walk: Walk | null;
			if (index === 0) {
				const page = await walkPage(ctx, threadId, inbox._id, outcome.cursor, now);
				outcome.isDone = page.isDone;
				outcome.cursor = page.cursor;
				walk = page;
			} else {
				walk = await walkWhole(ctx, threadId, inbox._id, now, left);
			}
			if (!walk) {
				// It did not fit what was left: the next call starts with it.
				outcome.isDone = false;
				isSpent = true;
				continue;
			}
			left.scan -= walk.read;
			left.move -= walk.eligible.length;
			if (walk.eligible.length === 0) continue;
			for (const id of walk.eligible) threadOf.set(id, threadId);
			byMailbox.set(thread.mailboxId, [
				...(byMailbox.get(thread.mailboxId) ?? []),
				...walk.eligible,
			]);
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
		// folder roles, the same field the inbox list filters on. Read for every
		// thread the call finished, moved or not: a finishing page can be empty
		// when an earlier call moved the rest.
		for (const outcome of outcomes.values()) {
			if (!outcome.isDone || !reached.has(outcome.threadId)) continue;
			const thread = await ctx.db.get(outcome.threadId);
			outcome.hasLeftInbox = !thread || !thread.folderRoles.includes('inbox');
		}
		return { ok: true, moved, threads: [...outcomes.values()] };
	},
});
