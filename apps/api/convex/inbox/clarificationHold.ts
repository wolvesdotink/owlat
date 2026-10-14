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
	const target = await clarificationTarget(ctx, message, await listSharedInboxReaderIds(ctx));
	return target.recipients;
}

/**
 * {@link resolveClarificationRecipients} against a reader list the caller read
 * once (the reminder reads it once per run, not once per question). `assignee`
 * is set when one person has to answer; absent, the readers do.
 */
export async function clarificationTarget(
	ctx: MutationCtx,
	message: Pick<Doc<'inboundMessages'>, 'assignedTo' | 'threadId'>,
	readers: readonly string[]
): Promise<{ assignee?: string; recipients: string[] }> {
	const isReader = (userId: string | undefined): userId is string =>
		userId !== undefined && readers.includes(userId);
	if (isReader(message.assignedTo)) {
		return { assignee: message.assignedTo, recipients: [message.assignedTo] };
	}
	const thread = message.threadId ? await ctx.db.get(message.threadId) : null;
	if (isReader(thread?.assignedTo)) {
		return { assignee: thread.assignedTo, recipients: [thread.assignedTo] };
	}
	return { recipients: [...readers] };
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

/** Held messages one settle, reopen or follow-up page updates per transaction. */
const SYNC_PAGE = 50;

/**
 * Keep `isThreadSettled` on a thread's held messages in step with its status.
 * Called by the thread module whenever a status change crosses between open
 * (`open`, `waiting`) and settled (`resolved`, `closed`). Reads only the
 * thread's held messages (never its whole history): the first page here, in
 * the transition, and when there may be more, the whole set again in
 * scheduled pages (`./clarificationHoldSync.ts`), which walk it with a
 * paginate cursor so rows sharing a creation time are never skipped.
 */
export async function syncHeldClarifications(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	status: string
): Promise<void> {
	const held = await heldOf(ctx, threadId).take(SYNC_PAGE);
	await applySettled(ctx, held, status);
	if (held.length === SYNC_PAGE) {
		await ctx.scheduler.runAfter(
			0,
			internal.inbox.clarificationHoldSync.syncHeldClarificationsPage,
			{
				threadId,
				cursor: null,
			}
		);
	}
}

/**
 * One scheduled page. It applies the thread's status as it is NOW, not as it
 * was when the page was scheduled, so a settle and a reopen racing each other
 * always end on the thread's last state; rows already right are left alone.
 */
export async function syncHeldPage(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	cursor: string | null
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const page = await heldOf(ctx, threadId).paginate({ numItems: SYNC_PAGE, cursor });
	await applySettled(ctx, page.page, thread.status);
	if (!page.isDone) {
		await ctx.scheduler.runAfter(
			0,
			internal.inbox.clarificationHoldSync.syncHeldClarificationsPage,
			{
				threadId,
				cursor: page.continueCursor,
			}
		);
	}
}

/** A thread's held messages, in creation order. */
function heldOf(ctx: MutationCtx, threadId: Id<'conversationThreads'>) {
	return ctx.db
		.query('inboundMessages')
		.withIndex('by_thread_and_processing_status', (q) =>
			q.eq('threadId', threadId).eq('processingStatus', 'awaiting_clarification')
		);
}

async function applySettled(
	ctx: MutationCtx,
	messages: readonly Doc<'inboundMessages'>[],
	status: string
): Promise<void> {
	const isSettled = SETTLED_THREAD_STATUSES.has(status);
	for (const message of messages) {
		if ((message.isThreadSettled === true) === isSettled) continue;
		await ctx.db.patch(message._id, { isThreadSettled: isSettled ? true : undefined });
	}
}

/** Whether `status` is a thread status that needs no answer. */
export function isSettledThreadStatus(status: string): boolean {
	return SETTLED_THREAD_STATUSES.has(status);
}

// ─── Reminder bookkeeping (a reminder notice per message and person) ────────

/** The most notices one question can carry: an ask and a reminder per reader, with room. */
export const MAX_NOTICES_PER_QUESTION = 500;

/**
 * Who the reminder already asked about `inboundMessageId`, in ONE range read
 * of the question's notices (not one read per person), and how many notices
 * that read. A question carries at most an ask and a reminder per
 * shared-inbox reader (`access.listSharedInboxReaderIds` reads at most 200).
 */
export async function remindedUserIds(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<{ userIds: Set<string>; read: number }> {
	const notices = await ctx.db
		.query('inboxAssignmentNotices')
		.withIndex('by_inbound_message_and_user', (q) => q.eq('inboundMessageId', inboundMessageId))
		.take(MAX_NOTICES_PER_QUESTION);
	const userIds = new Set(notices.filter((n) => n.isReminder === true).map((n) => n.userId));
	return { userIds, read: notices.length };
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
