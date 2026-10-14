/**
 * The abandoned-question reminder's sends (#1343), split out of
 * `processingLifecycle.reconcileAbandonedClarifications`.
 *
 * The cron keeps the Answer queue's index right for every held row and hands
 * the overdue ones here, as a sub-transaction it catches: a failure here never
 * undoes that bookkeeping. One run is bounded on both sides of a transaction's
 * limits:
 *   - sends: each reminder schedules a push per person with a device, and a
 *     transaction may schedule at most 1,000 functions, so a run sends at most
 *     {@link MAX_REMINDER_SENDS};
 *   - reads: who was already reminded comes from ONE range read of the
 *     question's notices (`clarificationHold.remindedUserIds`), the reader
 *     list is read once per run, and the notices a run reads count against
 *     {@link MAX_REMINDER_READS}.
 * Progress survives across runs: once everyone a question's target names has
 * been reminded, the question records that target (`isRemindedForReaders`, or
 * `remindedForUserId` for an assignee) and later runs skip it without reading
 * its notices. A new assignee is a new target. Whoever is over a budget is
 * asked on the next run; a person counts as reminded only once their notice
 * exists, so nobody is asked twice.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { DEFAULT_CLARIFICATION_TIMEOUT_MS } from './processingLifecycle';
import { notifyClarification } from './processingLifecycle/effects';
import { listSharedInboxReaderIds } from './access';
import { clarificationTarget, isClarificationLive, remindedUserIds } from './clarificationHold';

/**
 * Reminder notices (and so scheduled pushes) one run sends. Well under the
 * 1,000 scheduled functions a transaction may make, with room for the cron's
 * own follow-up page.
 */
export const MAX_REMINDER_SENDS = 400;

/**
 * Notices one run reads to learn who was already reminded. With the sends'
 * own reads (a device lookup per send) and the questions themselves, a run
 * stays far below the 4,096 index ranges and the documents a transaction may
 * read.
 */
export const MAX_REMINDER_READS = 2000;

export const remindHeldClarifications = internalMutation({
	args: { inboundMessageIds: v.array(v.id('inboundMessages')) },
	handler: async (ctx, args): Promise<{ reminded: number }> => {
		const configs = await ctx.db.query('agentConfig').take(1);
		const windowMs = Math.max(
			0,
			configs[0]?.clarificationTimeoutMs ?? DEFAULT_CLARIFICATION_TIMEOUT_MS
		);
		const now = Date.now();
		const cutoff = now - windowMs;
		const readers = await listSharedInboxReaderIds(ctx);
		let sends = MAX_REMINDER_SENDS;
		let reads = MAX_REMINDER_READS;
		let reminded = 0;
		for (const id of args.inboundMessageIds) {
			if (sends <= 0 || reads <= 0) break;
			const message = await ctx.db.get(id);
			const pending = message?.pendingClarification;
			if (!message?.threadId || !pending || pending.askedAt > cutoff) continue;
			if (!(await isClarificationLive(ctx, message))) continue;
			// Each person who has to answer now is asked again once: an assignee
			// who left or lost the role is replaced by the readers, and a new
			// assignee hears of it, but nobody is reminded twice.
			const target = await clarificationTarget(ctx, message, readers);
			const isDone = target.assignee
				? pending.remindedForUserId === target.assignee
				: pending.isRemindedForReaders === true;
			if (isDone) continue;
			const already = await remindedUserIds(ctx, message._id);
			reads -= already.read;
			const fresh = target.recipients.filter((userId) => !already.userIds.has(userId));
			const batch = fresh.slice(0, sends);
			if (batch.length > 0) {
				await notifyClarification(ctx, message._id, batch, { isReminder: true });
				sends -= batch.length;
				reminded++;
			}
			// Everyone the target names has been reminded: later runs skip it.
			const isComplete = batch.length === fresh.length;
			if (batch.length > 0 || isComplete) {
				await ctx.db.patch(message._id, {
					pendingClarification: {
						...pending,
						...(batch.length > 0 ? { remindedAt: now } : {}),
						...(isComplete && target.assignee ? { remindedForUserId: target.assignee } : {}),
						...(isComplete && !target.assignee ? { isRemindedForReaders: true } : {}),
					},
				});
			}
		}
		return { reminded };
	},
});
