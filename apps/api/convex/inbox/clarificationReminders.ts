/**
 * The abandoned-question reminder's sends (#1343).
 *
 * `processingLifecycle.reconcileAbandonedClarifications` keeps the Answer
 * queue's index right and starts ONE chain of this worker per run, by
 * scheduling it: the sends never share a transaction with the cron's scan.
 * Each link of the chain is its own transaction, bounded by its shape rather
 * than by budgets it counts:
 *   - held messages: one page of at most {@link LINK_PAGE} rows through
 *     `paginate`, which also stops at {@link LINK_PAGE_BYTES} (a held message
 *     keeps its body inline; the page overshoots by at most the one row that
 *     crosses it). Each row is read once: its notices and its target reuse
 *     the loaded document;
 *   - threads: one `get` per row, so at most {@link LINK_PAGE} documents of at
 *     most 1 MiB;
 *   - who was reminded: one point lookup per (question, person) on the
 *     notices' (message, person, ask) index, at most one small row each
 *     (`clarificationHold.hasReminder`), for at most 200 readers a question
 *     (`access.listSharedInboxReaderIds`), and the reader list read once;
 *   - sends: each reminder schedules a push per person with a device, and a
 *     transaction may schedule at most 1,000 functions. A run sends at most
 *     {@link MAX_REMINDER_SENDS} in all, carried along the chain as
 *     `sendsLeft`.
 * A link finishes every row of its page before the next link takes the next
 * page, so the chain's cursor only ever moves forward; it schedules at most
 * one continuation and ends when the run's sends are spent or the held rows
 * are.
 *
 * Progress survives across runs: once everyone a question's target names has
 * been reminded, the question records that target (`isRemindedForReaders`, or
 * `remindedForUserId` for an assignee) and later links skip it without any
 * lookup. A new assignee is a new target, and a new ask has a new `askedAt`.
 *
 * Overlap is harmless, so nothing guards against it: should a cron start a new
 * chain while the last one still runs, both look up a person's reminder before
 * they write one, so Convex serializes the two writes and the later link sees
 * the earlier one's notice; nobody is reminded twice. At worst the two chains
 * share out more than one run's share of sends between them.
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
const LINK_PAGE = 8;
const LINK_PAGE_BYTES = 2 * 1024 * 1024;

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
		let reminded = 0;
		for (const message of page.page) {
			// The run's sends are spent: the rest wait for the next run.
			if (sendsLeft <= 0) break;
			const sent = await remindOne(ctx, message, { cutoff, readersOnce, sendsLeft, now });
			sendsLeft -= sent;
			if (sent > 0) reminded++;
		}

		// Every row of this page is done: the next link takes the next page.
		if (sendsLeft > 0 && !page.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.inbox.clarificationReminders.remindHeldClarifications,
				{ cursor: page.continueCursor, sendsLeft }
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
