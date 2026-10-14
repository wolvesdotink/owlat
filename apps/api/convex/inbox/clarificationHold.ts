/**
 * A team message held on the agent's questions (#1343): when it still needs
 * someone, and who that someone is.
 *
 * Nothing drafts around an unanswered question any more, so a message can sit
 * in `awaiting_clarification` for as long as nobody answers. It belongs in the
 * Answer queue and may be asked about again (`processingLifecycle.
 * reconcileAbandonedClarifications`) only while its conversation is still
 * open: a thread someone resolved or closed needs no answer, and a notice
 * queued before that happened is neither pushed (`push/dispatch.ts`) nor shown
 * (`queries.pendingAssignments`).
 *
 * The queue reads held messages through an index that leaves out settled
 * conversations (`isThreadSettled`, kept by the thread module on every settle
 * and reopen), so open questions are never crowded out by settled ones.
 */

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { listSharedInboxReaderIds } from './access';

/** Thread statuses that need no answer. */
const SETTLED_THREAD_STATUSES: ReadonlySet<string> = new Set(['resolved', 'closed']);

/** Whether `message` still waits on an answer to the agent's questions. */
export async function isClarificationLive(
	ctx: QueryCtx | MutationCtx,
	message: Pick<Doc<'inboundMessages'>, 'processingStatus' | 'threadId'>
): Promise<boolean> {
	if (message.processingStatus !== 'awaiting_clarification') return false;
	if (!message.threadId) return true;
	const thread = await ctx.db.get(message.threadId);
	return !thread || !SETTLED_THREAD_STATUSES.has(thread.status);
}

/**
 * Who has to answer the agent's questions: the message's assignee, else the
 * thread's, else every shared-inbox reader (owner / admin), the set that sees
 * the review queue. An assignee counts only while they still read the shared
 * inbox: one who left the organization or lost the role would get a notice
 * they cannot open, and nobody who can would hear of it.
 */
export async function resolveClarificationRecipients(
	ctx: MutationCtx,
	message: Pick<Doc<'inboundMessages'>, 'assignedTo' | 'threadId'>
): Promise<string[]> {
	const readers = await listSharedInboxReaderIds(ctx);
	const isReader = (userId: string | undefined): userId is string =>
		userId !== undefined && readers.includes(userId);
	if (isReader(message.assignedTo)) return [message.assignedTo];
	const thread = message.threadId ? await ctx.db.get(message.threadId) : null;
	if (isReader(thread?.assignedTo)) return [thread.assignedTo];
	return readers;
}

/** Held messages the queue reads past its limit before it stops (stragglers). */
const HELD_SCAN_BUDGET = 200;

/**
 * The review queue's rows (`queries.getReviewQueue` and its badge count, so
 * the two agree), newest first: `draft_ready` messages, and messages held on
 * the agent's questions on open conversations. The held ones come from the
 * index that leaves settled conversations out; the live check behind it only
 * skips a straggler the index has not caught up with (a row from before the
 * flag, which the reminder cron marks), within a bounded read.
 */
export async function readPendingReview(ctx: QueryCtx, limit: number) {
	const drafts = await ctx.db
		.query('inboundMessages')
		.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'draft_ready'))
		.order('desc')
		.take(limit);
	const held: Doc<'inboundMessages'>[] = [];
	let scanned = 0;
	for await (const message of ctx.db
		.query('inboundMessages')
		.withIndex('by_processing_status_and_thread_settled', (q) =>
			q.eq('processingStatus', 'awaiting_clarification').eq('isThreadSettled', undefined)
		)
		.order('desc')) {
		if (held.length >= limit || scanned >= limit + HELD_SCAN_BUDGET) break;
		scanned++;
		if (await isClarificationLive(ctx, message)) held.push(message);
	}
	return [...drafts, ...held].sort((a, b) => b._creationTime - a._creationTime).slice(0, limit);
}

/** Held messages one settle or reopen updates per transaction. */
const SYNC_PAGE = 50;

/**
 * Keep `isThreadSettled` on a thread's held messages in step with its status.
 * Called by the thread module whenever a status change crosses between open
 * (`open`, `waiting`) and settled (`resolved`, `closed`). Reads only the
 * thread's held messages (never its whole history), a bounded page at a time;
 * a longer tail continues in scheduled pages.
 */
export async function syncHeldClarifications(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	status: string
): Promise<void> {
	await syncHeldPage(ctx, threadId, status, undefined);
}

/** One page of {@link syncHeldClarifications}, after `after` (`_creationTime`). */
export async function syncHeldPage(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	status: string,
	after: number | undefined
): Promise<void> {
	const isSettled = SETTLED_THREAD_STATUSES.has(status);
	const held = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread_and_processing_status', (q) => {
			const range = q.eq('threadId', threadId).eq('processingStatus', 'awaiting_clarification');
			return after === undefined ? range : range.gt('_creationTime', after);
		})
		.take(SYNC_PAGE);
	for (const message of held) {
		if ((message.isThreadSettled === true) === isSettled) continue;
		await ctx.db.patch(message._id, { isThreadSettled: isSettled ? true : undefined });
	}
	const last = held[held.length - 1];
	if (held.length === SYNC_PAGE && last) {
		await ctx.scheduler.runAfter(
			0,
			internal.inbox.clarificationHoldSync.syncHeldClarificationsPage,
			{
				threadId,
				after: last._creationTime,
			}
		);
	}
}

/** Whether `status` is a thread status that needs no answer. */
export function isSettledThreadStatus(status: string): boolean {
	return SETTLED_THREAD_STATUSES.has(status);
}

// ─── Reminder bookkeeping (a reminder notice per message and person) ────────

/** Of `userIds`, those the reminder has not asked about `inboundMessageId` yet. */
export async function notRemindedYet(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	userIds: readonly string[]
): Promise<string[]> {
	const fresh: string[] = [];
	for (const userId of userIds) {
		const notices = await ctx.db
			.query('inboxAssignmentNotices')
			.withIndex('by_inbound_message_and_user', (q) =>
				q.eq('inboundMessageId', inboundMessageId).eq('userId', userId)
			)
			.collect(); // bounded: the ask and at most one reminder per person
		if (!notices.some((notice) => notice.isReminder === true)) fresh.push(userId);
	}
	return fresh;
}

/**
 * The questions are answered, dismissed or taken over: their notices go, the
 * reminder records with them, so a later ask about new questions starts over.
 */
export async function clearClarificationReminders(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<void> {
	const notices = await ctx.db
		.query('inboxAssignmentNotices')
		.withIndex('by_inbound_message_and_user', (q) => q.eq('inboundMessageId', inboundMessageId))
		.collect(); // bounded: an ask and a reminder per shared-inbox reader
	for (const notice of notices) {
		if (notice.kind === 'clarification') await ctx.db.delete(notice._id);
	}
}

/**
 * Notices a person should still see: a clarification notice only while its
 * question still waits on an answer on an open conversation.
 */
export async function liveNotices<
	N extends { kind?: string | undefined; inboundMessageId?: Id<'inboundMessages'> | undefined },
>(ctx: QueryCtx, notices: readonly N[]): Promise<N[]> {
	const out: N[] = [];
	for (const notice of notices) {
		if (notice.kind === 'clarification' && notice.inboundMessageId) {
			const message = await ctx.db.get(notice.inboundMessageId);
			if (!message || !(await isClarificationLive(ctx, message))) continue;
		}
		out.push(notice);
	}
	return out;
}
