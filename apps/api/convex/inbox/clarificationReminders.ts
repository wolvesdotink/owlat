/**
 * The abandoned-question reminder's sends (#1343).
 *
 * `processingLifecycle.reconcileAbandonedClarifications` keeps the Answer
 * queue's index right and starts ONE chain of this worker per run, by
 * scheduling it with the run's cutoff: the sends never share a transaction
 * with the cron's scan. Each link of the chain is its own transaction.
 *
 * Order: the link walks held messages least recently reminded first
 * (`lastReminderAt`, absent first, then oldest). A question that just drew
 * reminders moves to the back, so the run's capped sends reach every question
 * in turn and none waits forever behind others that keep asking anew. Nothing
 * is shared between links but the cursor they pass on, so overlapping chains
 * need no guard (see the end of this comment).
 *
 * WORST-CASE READS PER LINK, by shape (a document is at most 1 MiB):
 *   - held messages: one `paginate` page of at most {@link LINK_PAGE} rows
 *     that stops at {@link LINK_PAGE_BYTES}, overshooting by at most one
 *     document: 1 MiB + 1 MiB = 2 MiB;
 *   - the patch of each row it reminds reads that row again: 2 MiB;
 *   - threads, one `get` per row: 4 x 1 MiB = 4 MiB;
 *   - who was reminded: one point lookup per (question, person), at most one
 *     row each (`clarificationHold.hasReminder`), for at most 200 readers a
 *     question (`access.listSharedInboxReaderIds`). A reminder notice keeps
 *     at most 200 UTF-16 units of subject and of sender (<= 600 bytes each)
 *     beside ids and numbers, so <= 2 KiB: 4 x 200 x 2 KiB = 1.6 MiB;
 *   - push devices, one `.first()` per send (`push/events.enqueuePush`), at
 *     most {@link MAX_REMINDER_SENDS} sends; a device row is capped at a
 *     2,048-character endpoint, a 200-character key, an 80-character label
 *     and a 64-character time zone, so <= 4 KiB: 400 x 4 KiB = 1.6 MiB;
 *   - the reader list, read once per link: <= 200 member rows, < 0.2 MiB;
 *   - no `agentConfig` read (the cron passes the cutoff) and no second read
 *     of a message (the notice reuses the loaded row).
 * Total <= 11.4 MiB of the 16 MiB a transaction may read. Index ranges: at
 * most 4 x 200 lookups + 400 device lookups + a few, far below 4,096. Writes:
 * at most 400 small notices and 4 message patches (<= 4 MiB). Scheduled
 * functions: at most 400 pushes and one continuation.
 *
 * A link finishes every row of its page before the next link takes the next
 * page, so the chain's cursor only moves forward; it ends when the run's sends
 * are spent or the held rows are.
 *
 * Progress survives across runs: once everyone a question's target names has
 * been reminded, the question records that target (`isRemindedForReaders`, or
 * `remindedForUserId` for an assignee) and later links skip it without any
 * lookup. A new assignee is a new target, and a new ask has a new `askedAt`.
 *
 * Overlap is harmless: should a cron start a new chain while the last one
 * still runs, both look up a person's reminder before they write one, so
 * Convex serializes the two writes and the later link sees the earlier one's
 * notice; nobody is reminded twice. At worst the two chains share out more
 * than one run's share of sends between them.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { notifyClarification } from './processingLifecycle/effects';
import { listSharedInboxReaderIds } from './access';
import { clarificationTarget, hasReminder, isSettledThreadStatus } from './clarificationHold';

/** Default window before an unanswered clarification is asked again.
 * Overridable per-deployment via `agentConfig.clarificationTimeoutMs`. */
export const DEFAULT_CLARIFICATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Reminder notices (and so scheduled pushes) one cron run sends, along its
 * whole chain. Well under the 1,000 functions a transaction may schedule, with
 * room for a link's continuation.
 */
export const MAX_REMINDER_SENDS = 400;

/** Held messages one link pages over, and the bytes that page may read. */
const LINK_PAGE = 4;
const LINK_PAGE_BYTES = 1024 * 1024;

export const remindHeldClarifications = internalMutation({
	args: {
		cursor: v.union(v.string(), v.null()),
		sendsLeft: v.number(),
		// Questions asked before this are overdue (the cron reads the window).
		cutoff: v.number(),
	},
	handler: async (ctx, args): Promise<{ reminded: number }> => {
		const now = Date.now();
		// Read once per link, and only when a question needs it.
		let readers: string[] | undefined;
		const readersOnce = async () => (readers ??= await listSharedInboxReaderIds(ctx));
		const page = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status_and_last_reminder', (q) =>
				q.eq('processingStatus', 'awaiting_clarification')
			)
			.paginate({ numItems: LINK_PAGE, cursor: args.cursor, maximumBytesRead: LINK_PAGE_BYTES });

		let sendsLeft = Math.min(args.sendsLeft, MAX_REMINDER_SENDS);
		let reminded = 0;
		for (const message of page.page) {
			// The run's sends are spent: the rest wait for the next run.
			if (sendsLeft <= 0) break;
			const sent = await remindOne(ctx, message, {
				cutoff: args.cutoff,
				readersOnce,
				sendsLeft,
				now,
			});
			sendsLeft -= sent;
			if (sent > 0) reminded++;
		}

		// Every row of this page is done: the next link takes the next page.
		if (sendsLeft > 0 && !page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.inbox.clarificationReminders.remindHeldClarifications,
				{ cursor: page.continueCursor, sendsLeft, cutoff: args.cutoff }
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
): Promise<number> {
	const pending = message.pendingClarification;
	if (!message.threadId || !pending || pending.askedAt > run.cutoff) return 0;
	const thread = await ctx.db.get(message.threadId);
	// A conversation someone resolved or closed needs no answer.
	if (thread && isSettledThreadStatus(thread.status)) return 0;
	// Each person who has to answer now is asked again once: an assignee who
	// left or lost the role is replaced by the readers, and a new assignee hears
	// of it, but nobody is reminded twice.
	const target = await clarificationTarget(ctx, message, await run.readersOnce(), thread);
	const isDone = target.assignee
		? pending.remindedForUserId === target.assignee
		: pending.isRemindedForReaders === true;
	if (isDone) return 0;
	const fresh: string[] = [];
	for (const userId of target.recipients) {
		if (!(await hasReminder(ctx, message._id, userId, pending.askedAt))) fresh.push(userId);
	}
	const batch = fresh.slice(0, run.sendsLeft);
	if (batch.length > 0) {
		await notifyClarification(ctx, message._id, batch, {
			reminderAskedAt: pending.askedAt,
			message,
		});
	}
	// Everyone the target names has been reminded: later runs skip it.
	const isComplete = batch.length === fresh.length;
	if (batch.length > 0 || isComplete) {
		await ctx.db.patch(message._id, {
			// To the back of the next run's walk, once it drew reminders.
			...(batch.length > 0 ? { lastReminderAt: run.now } : {}),
			pendingClarification: {
				...pending,
				...(batch.length > 0 ? { remindedAt: run.now } : {}),
				...(isComplete && target.assignee ? { remindedForUserId: target.assignee } : {}),
				...(isComplete && !target.assignee ? { isRemindedForReaders: true } : {}),
			},
		});
	}
	return batch.length;
}
