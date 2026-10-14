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

import { getConvexSize, type Value } from 'convex/values';
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
	readers: readonly string[],
	/** The message's thread when the caller already read it (null: none). */
	loadedThread?: Doc<'conversationThreads'> | null
): Promise<{ assignee?: string; recipients: string[] }> {
	const isReader = (userId: string | undefined): userId is string =>
		userId !== undefined && readers.includes(userId);
	if (isReader(message.assignedTo)) {
		return { assignee: message.assignedTo, recipients: [message.assignedTo] };
	}
	const thread =
		loadedThread !== undefined
			? loadedThread
			: message.threadId
				? await ctx.db.get(message.threadId)
				: null;
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

/**
 * The settlement sync's reads, by shape (a document is at most 1 MiB):
 *   - in the transition (it runs inside whatever settles or reopens the
 *     thread, so its share stays small): held messages read one at a time,
 *     stopping as soon as {@link INLINE_ROWS} rows or {@link INLINE_BYTES}
 *     have been read, so the rows before the last stay under 1 MiB and the
 *     last is at most 1 MiB: 2 MiB. The patches of those rows read them
 *     again: 2 MiB. 4 MiB in all;
 *   - in a scheduled page: the thread (1 MiB), a `paginate` page of at most
 *     {@link PAGE_ROWS} rows that stops at {@link PAGE_BYTES} (2 MiB + one
 *     1 MiB overshoot = 3 MiB), and the patches reading those rows again
 *     (3 MiB). 7 MiB in all, of the 16 MiB a transaction may read.
 */
const INLINE_ROWS = 4;
const INLINE_BYTES = 1024 * 1024;
const PAGE_ROWS = 8;
const PAGE_BYTES = 2 * 1024 * 1024;

/**
 * Keep `isThreadSettled` on a thread's held messages in step with its status.
 * Called by the thread module whenever a status change crosses between open
 * (`open`, `waiting`) and settled (`resolved`, `closed`). Reads only the
 * thread's held messages (never its whole history), bounded by rows and bytes:
 * the first few here, in the transition, and when there may be more, the
 * whole set again in scheduled pages (`./clarificationHoldSync.ts`), which
 * walk it with a paginate cursor so rows sharing a creation time are never
 * skipped.
 */
export async function syncHeldClarifications(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	status: string
): Promise<void> {
	const held: Doc<'inboundMessages'>[] = [];
	let bytes = 0;
	let isMore = false;
	for await (const message of heldOf(ctx, threadId)) {
		held.push(message);
		bytes += documentBytes(message);
		// Stop as soon as the budget is reached, before reading another row:
		// whatever is left (perhaps nothing) goes to the scheduled pages.
		if (held.length >= INLINE_ROWS || bytes >= INLINE_BYTES) {
			isMore = true;
			break;
		}
	}
	await applySettled(ctx, held, status);
	if (isMore) {
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
	const page = await heldOf(ctx, threadId).paginate({
		numItems: PAGE_ROWS,
		cursor,
		maximumBytesRead: PAGE_BYTES,
	});
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

/** What reading `doc` costs a transaction's read limit, roughly. */
export function documentBytes(doc: unknown): number {
	return getConvexSize(doc as Value) + 128;
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

// ─── Reminder bookkeeping (a reminder notice per message, person and ask) ───

/**
 * Whether `userId` was already reminded about the questions `inboundMessageId`
 * asked at `askedAt`: ONE point lookup on the notices' (message, person, ask)
 * index, which returns at most one row, a reminder notice this module wrote
 * (its subject is capped, `processingLifecycle/effects.notifyClarification`).
 * No range of notices is read, and no cap can hide a reminder.
 */
export async function hasReminder(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	userId: string,
	askedAt: number
): Promise<boolean> {
	const reminder = await ctx.db
		.query('inboxAssignmentNotices')
		.withIndex('by_inbound_message_user_and_reminder', (q) =>
			q.eq('inboundMessageId', inboundMessageId).eq('userId', userId).eq('reminderAskedAt', askedAt)
		)
		.first();
	return reminder !== null;
}

/** Notices one cleanup page deletes, and the bytes it may read. */
const CLEANUP_PAGE = 64;
const CLEANUP_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * The questions are answered, dismissed or taken over: their notices go.
 * Not in the transaction that settles them (a question may carry an ask and a
 * reminder per reader): a scheduled cleanup pages through them
 * (`./clarificationHoldSync.ts`). It deletes the notices of the settled ask
 * only, by the ask they carry (`askedAt`), never by when they were written,
 * so a question asked again meanwhile keeps its new notices whatever the
 * clock says. Notices from before asks were stamped carry none and go too.
 */
export async function clearClarificationReminders(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	askedAt: number | undefined
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.inbox.clarificationHoldSync.clearClarificationNotices, {
		inboundMessageId,
		askedAt: askedAt ?? null,
		cursor: null,
	});
}

/** One page of the cleanup; schedules the next while there is more. */
export async function clearNoticesPage(
	ctx: MutationCtx,
	inboundMessageId: Id<'inboundMessages'>,
	askedAt: number | null,
	cursor: string | null
): Promise<void> {
	const page = await ctx.db
		.query('inboxAssignmentNotices')
		.withIndex('by_inbound_message_user_and_reminder', (q) =>
			q.eq('inboundMessageId', inboundMessageId)
		)
		.paginate({ numItems: CLEANUP_PAGE, cursor, maximumBytesRead: CLEANUP_PAGE_BYTES });
	for (const notice of page.page) {
		if (notice.kind !== 'clarification') continue;
		const isSettledAsk = notice.askedAt === undefined || notice.askedAt === askedAt;
		if (isSettledAsk) await ctx.db.delete(notice._id);
	}
	if (!page.isDone) {
		await ctx.scheduler.runAfter(
			0,
			internal.inbox.clarificationHoldSync.clearClarificationNotices,
			{
				inboundMessageId,
				askedAt,
				cursor: page.continueCursor,
			}
		);
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
