/**
 * The abandoned-question reminder's sends (#1343), split out of
 * `processingLifecycle.reconcileAbandonedClarifications`.
 *
 * The cron keeps the Answer queue's index right for every held row and hands
 * the overdue ones here, as a sub-transaction it catches: a failure here never
 * undoes that bookkeeping. Each reminder schedules a push per person with a
 * device, and one transaction may schedule at most 1,000 functions, so a run
 * sends at most {@link MAX_REMINDER_SENDS}. Whoever is over the budget is asked
 * on the next run: a person counts as reminded only once their notice exists
 * (`clarificationHold.notRemindedYet`), so nobody is asked twice.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { DEFAULT_CLARIFICATION_TIMEOUT_MS } from './processingLifecycle';
import { notifyClarification } from './processingLifecycle/effects';
import {
	isClarificationLive,
	notRemindedYet,
	resolveClarificationRecipients,
} from './clarificationHold';

/**
 * Reminder notices (and so scheduled pushes) one run sends. Well under the
 * 1,000 scheduled functions a transaction may make, with room for the cron's
 * own follow-up page.
 */
export const MAX_REMINDER_SENDS = 400;

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
		let budget = MAX_REMINDER_SENDS;
		let reminded = 0;
		for (const id of args.inboundMessageIds) {
			if (budget <= 0) break;
			const message = await ctx.db.get(id);
			const pending = message?.pendingClarification;
			if (!message?.threadId || !pending || pending.askedAt > cutoff) continue;
			if (!(await isClarificationLive(ctx, message))) continue;
			// Each person who has to answer now is asked again once: an assignee
			// who left or lost the role is replaced by the readers, and a new
			// assignee hears of it, but nobody is reminded twice.
			const eligible = await resolveClarificationRecipients(ctx, message);
			const fresh = (await notRemindedYet(ctx, message._id, eligible)).slice(0, budget);
			if (fresh.length === 0) continue;
			await notifyClarification(ctx, message._id, fresh, { isReminder: true });
			await ctx.db.patch(message._id, { pendingClarification: { ...pending, remindedAt: now } });
			budget -= fresh.length;
			reminded++;
		}
		return { reminded };
	},
});
