/**
 * The response-target breach sweep (cron, every minute).
 *
 * A thread whose running deadline has passed gets one `sla_breach` notice per
 * clock, through the same `inboxAssignmentNotices` surface as assignments and
 * clarification asks (in-app toast, desktop notification). It goes to the
 * assignee; an unassigned thread notifies every shared-inbox reader, as a
 * clarification ask does. `slaBreachNotifiedAt` marks the clock as notified
 * and takes it out of the index range this sweep reads, so a sweep never
 * re-reads what it already handled. A new clock clears the mark.
 */

import { internalMutation } from '../../lib/writeFence';
import { listSharedInboxReaderIds } from '../access';
import { loadSlaPolicy } from './policy';

/** Threads per tick; the rest wait a minute. */
const SWEEP_LIMIT = 50;

export const sweep = internalMutation({
	args: {},
	handler: async (ctx): Promise<{ notified: number }> => {
		if (!(await loadSlaPolicy(ctx))) return { notified: 0 };
		const now = Date.now();
		const due = await ctx.db
			.query('conversationThreads')
			.withIndex('by_breach_notified_and_response_due_at', (q) =>
				q.eq('slaBreachNotifiedAt', undefined).gt('responseDueAt', 0).lte('responseDueAt', now)
			)
			.take(SWEEP_LIMIT);

		let readers: string[] | null = null;
		for (const thread of due) {
			const recipients = thread.assignedTo
				? [thread.assignedTo]
				: (readers ??= await listSharedInboxReaderIds(ctx));
			for (const userId of recipients) {
				await ctx.db.insert('inboxAssignmentNotices', {
					kind: 'sla_breach',
					userId,
					threadId: thread._id,
					subject: thread.subject,
					assignedByName: thread.contactIdentifier,
					createdAt: now,
				});
			}
			await ctx.db.patch(thread._id, { slaBreachNotifiedAt: now });
		}
		return { notified: due.length };
	},
});
