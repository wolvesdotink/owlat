/**
 * The abandoned-question reminder's sends (#1343).
 *
 * `processingLifecycle.reconcileAbandonedClarifications` keeps the Answer
 * queue's index right and starts ONE chain of this worker per run, by
 * scheduling it: the sends never share a transaction, or its read budget, with
 * the cron's own scan. Each link of the chain is its own transaction and stays
 * inside the platform's limits on every side:
 *   - rows: the held messages come a page at a time through `paginate`, bounded
 *     by bytes as well as count (a held message keeps its body inline), and each
 *     row is read once: the notice and the target reuse the loaded document;
 *   - extra reads: the thread and the question's notices (ONE range read per
 *     question, `clarificationHold.remindedUserIds`) are charged by size to
 *     {@link LINK_BYTES} and by count to {@link MAX_REMINDER_READS}; the reader
 *     list is read at most once per link;
 *   - sends: each reminder schedules a push per person with a device, and a
 *     transaction may schedule at most 1,000 functions. A run sends at most
 *     {@link MAX_REMINDER_SENDS} in all, carried along the chain as
 *     `sendsLeft`, so it stays one reminder share per cron run.
 * A link that runs out of reads before the page's end continues from the same
 * page; one whose page is done continues from the next. Each link schedules at
 * most one continuation, and the chain ends when the run's sends are spent or
 * the held rows are.
 *
 * Progress survives across runs: once everyone a question's target names has
 * been reminded, the question records that target (`isRemindedForReaders`, or
 * `remindedForUserId` for an assignee) and later links skip it without reading
 * its notices. A new assignee is a new target. A person counts as reminded only
 * once their notice exists.
 *
 * Overlap is harmless, so nothing guards against it: should a cron start a new
 * chain while the last one still runs, both read a question's notices before
 * they write one, so Convex serializes the two writes and the later link sees
 * the earlier one's notices; nobody is reminded twice. At worst the two chains
 * share out more than one run's share of sends between them.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { notifyClarification } from './processingLifecycle/effects';
import { listSharedInboxReaderIds } from './access';
import {
	clarificationTarget,
	documentBytes,
	isSettledThreadStatus,
	remindedUserIds,
} from './clarificationHold';

/** Default window before an unanswered clarification is asked again.
 * Overridable per-deployment via `agentConfig.clarificationTimeoutMs`. */
export const DEFAULT_CLARIFICATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Reminder notices (and so scheduled pushes) one cron run sends, along its
 * whole chain. Well under the 1,000 functions a transaction may schedule, with
 * room for a link's continuation.
 */
export const MAX_REMINDER_SENDS = 400;

/** Notices one link reads to learn who was already reminded. */
export const MAX_REMINDER_READS = 2000;

/** Held messages one link pages over, and the bytes that page may read. */
const LINK_PAGE = 50;
const LINK_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * Bytes a link may read beyond its page: threads and notices. With the page
 * and the writes, a link stays far below the 16 MiB a transaction may read.
 */
export const LINK_BYTES = 4 * 1024 * 1024;

export const remindHeldClarifications = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), sendsLeft: v.number() },
	handler: async (ctx, args): Promise<{ reminded: number }> => {
		const configs = await ctx.db.query('agentConfig').take(1);
		const windowMs = Math.max(
			0,
			configs[0]?.clarificationTimeoutMs ?? DEFAULT_CLARIFICATION_TIMEOUT_MS
		);
		const now = Date.now();
		const cutoff = now - windowMs;
		// Read once per link, and only when a question needs it.
		let readers: string[] | undefined;
		const readersOnce = async () => (readers ??= await listSharedInboxReaderIds(ctx));
		const page = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'awaiting_clarification'))
			.paginate({ numItems: LINK_PAGE, cursor: args.cursor, maximumBytesRead: LINK_PAGE_BYTES });

		let sendsLeft = Math.min(args.sendsLeft, MAX_REMINDER_SENDS);
		let reads = MAX_REMINDER_READS;
		let bytes = LINK_BYTES;
		let reminded = 0;
		let isPageDone = true;
		for (const [index, message] of page.page.entries()) {
			if (sendsLeft <= 0) break;
			// At least one row per link, so the chain always moves.
			if (index > 0 && (reads <= 0 || bytes <= 0)) {
				isPageDone = false;
				break;
			}
			const result = await remindOne(ctx, message, { cutoff, readersOnce, sendsLeft, now });
			reads -= result.reads;
			bytes -= result.bytes;
			sendsLeft -= result.sent;
			if (result.sent > 0) reminded++;
		}

		// One continuation at most: the rest of this page, or the next one.
		if (sendsLeft > 0 && (!isPageDone || !page.isDone)) {
			await ctx.scheduler.runAfter(
				0,
				internal.inbox.clarificationReminders.remindHeldClarifications,
				{ cursor: isPageDone ? page.continueCursor : args.cursor, sendsLeft }
			);
		}
		return { reminded };
	},
});

/** Remind the people a held question still owes a reminder, up to `sendsLeft`. */
async function remindOne(
	ctx: Parameters<typeof notifyClarification>[0],
	message: Doc<'inboundMessages'>,
	run: {
		cutoff: number;
		readersOnce: () => Promise<readonly string[]>;
		sendsLeft: number;
		now: number;
	}
): Promise<{ sent: number; reads: number; bytes: number }> {
	const none = { sent: 0, reads: 0, bytes: 0 };
	const pending = message.pendingClarification;
	if (!message.threadId || !pending || pending.askedAt > run.cutoff) return none;
	const thread = await ctx.db.get(message.threadId);
	const threadBytes = thread ? documentBytes(thread) : 0;
	// A conversation someone resolved or closed needs no answer.
	if (thread && isSettledThreadStatus(thread.status)) return { ...none, bytes: threadBytes };
	// Each person who has to answer now is asked again once: an assignee who
	// left or lost the role is replaced by the readers, and a new assignee hears
	// of it, but nobody is reminded twice.
	const target = await clarificationTarget(ctx, message, await run.readersOnce(), thread);
	const isDone = target.assignee
		? pending.remindedForUserId === target.assignee
		: pending.isRemindedForReaders === true;
	if (isDone) return { ...none, bytes: threadBytes };
	const already = await remindedUserIds(ctx, message._id);
	const fresh = target.recipients.filter((userId) => !already.userIds.has(userId));
	const batch = fresh.slice(0, run.sendsLeft);
	if (batch.length > 0) {
		await notifyClarification(ctx, message._id, batch, { isReminder: true, message });
	}
	// Everyone the target names has been reminded: later runs skip it.
	const isComplete = batch.length === fresh.length;
	if (batch.length > 0 || isComplete) {
		await ctx.db.patch(message._id, {
			pendingClarification: {
				...pending,
				...(batch.length > 0 ? { remindedAt: run.now } : {}),
				...(isComplete && target.assignee ? { remindedForUserId: target.assignee } : {}),
				...(isComplete && !target.assignee ? { isRemindedForReaders: true } : {}),
			},
		});
	}
	return { sent: batch.length, reads: already.read, bytes: threadBytes + already.bytes };
}
