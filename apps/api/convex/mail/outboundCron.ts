/**
 * Safety-net cron: dispatch postbox drafts whose scheduledSendAt has
 * passed but never fired (e.g. the deployment was offline at sendAt).
 *
 * Runs every minute. Picks up to 50 drafts in `pending_send` or
 * `scheduled` state whose sendAt is in the past.
 */

import { internalMutation, internalAction } from '../_generated/server';
import { internal } from '../_generated/api';

const BATCH_SIZE = 50;
const STALE_THRESHOLD_MS = 5_000; // dispatch any draft >5s overdue

export const findOverdueDrafts = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - STALE_THRESHOLD_MS;

		// Range-scan the compound index per state: `state` equality + a
		// `scheduledSendAt <= cutoff` upper bound reads only the overdue tail of
		// each state's partition instead of collecting every pending/scheduled
		// draft and date-filtering in memory. Every `pending_send`/`scheduled`
		// draft is written with both `scheduledSendAt` and `undoToken` set
		// (draftLifecycle reducers), so the residual `undoToken` check is just a
		// type guard, not a filter.
		const pending = await ctx.db
			.query('mailDrafts')
			.withIndex('by_state_and_scheduled', (q) =>
				q.eq('state', 'pending_send').lte('scheduledSendAt', cutoff)
			)
			.take(BATCH_SIZE);
		const scheduled = await ctx.db
			.query('mailDrafts')
			.withIndex('by_state_and_scheduled', (q) =>
				q.eq('state', 'scheduled').lte('scheduledSendAt', cutoff)
			)
			.take(BATCH_SIZE);

		const overdue = [...pending, ...scheduled]
			.filter((d) => d.undoToken)
			.slice(0, BATCH_SIZE);

		return {
			items: overdue.map((d) => ({
				draftId: d._id,
				undoToken: d.undoToken as string,
			})),
			// A full batch means more overdue drafts may remain — the action
			// self-reschedules to drain them rather than waiting a full minute.
			full: overdue.length >= BATCH_SIZE,
		};
	},
});

export const dispatchOverdueDrafts = internalAction({
	args: {},
	handler: async (ctx): Promise<{ dispatched: number }> => {
		const { items, full }: {
			items: Array<{ draftId: import('../_generated/dataModel').Id<'mailDrafts'>; undoToken: string }>;
			full: boolean;
		} = await ctx.runMutation(internal.mail.outboundCron.findOverdueDrafts, {});

		let dispatched = 0;
		for (const item of items) {
			try {
				await ctx.runAction(internal.mail.outbound.dispatchDraft, item);
				dispatched++;
			} catch {
				// Errors are logged inside dispatchDraft; keep iterating
			}
		}

		// Drain a backlog: if the batch was full there may be more overdue drafts
		// waiting, so re-run immediately instead of waiting for the next tick.
		if (full) {
			await ctx.scheduler.runAfter(0, internal.mail.outboundCron.dispatchOverdueDrafts, {});
		}

		return { dispatched };
	},
});
