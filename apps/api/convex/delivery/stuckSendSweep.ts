import { v } from 'convex/values';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { logError, logWarn } from '../lib/runtimeLog';
import { supersedeCompletionFailures } from './sendCompletionFailures';

// ============================================================================
// Stuck queued Send sweep (module) — #1195.
//
// A Send leaves `queued` through its worker's completion or through provider
// feedback, and feedback finds a Send by its provider message id. A Send that
// is still `queued` with NO provider id long after the governed delivery
// deadline has neither left: its completion was lost (a throw before
// `sendCompletionFailures` existed, a workpool that dropped the work) and no
// webhook can ever match it. It would hold its campaign in `sending` forever.
//
// This sweep ends such a Send as `failed` under its own code, through the Send
// lifecycle, so stats, webhooks and campaign completion follow as for any other
// failure. Rows that carry a provider id are left alone: they are waiting on
// provider feedback or on a recorded completion, and feedback can still reach
// them.
//
// THE CUTOFF IS LATER THAN ANY LIVE SEND'S DEADLINE. Every governed outcome
// (deferral, ambiguous acceptance, parked acceptance) is bounded by the
// deadline measured from the FIRST attempt, which comes after the row was
// queued. The sweep measures from queueing and adds a day of grace, so it
// never races those arms' own terminal edges except for a Send whose first
// attempt waited more than a day in the queue.
// ============================================================================

export const STUCK_SEND_ERROR_CODE = 'SEND_COMPLETION_LOST';
const STUCK_SEND_ERROR_MESSAGE =
	'No send outcome was recorded before the delivery deadline; the message may or may not have been delivered';
const STUCK_SEND_GRACE_MS = 24 * 60 * 60 * 1000;
export const STUCK_SEND_AGE_MS = GOVERNED_MTA_MAX_MESSAGE_AGE_MS + STUCK_SEND_GRACE_MS;
const PAGE_SIZE = 25;

const sendTableValidator = v.union(v.literal('emailSends'), v.literal('transactionalSends'));

/**
 * One page of one table, oldest first. The cron starts it with no arguments;
 * each page schedules the next, and `emailSends` hands over to
 * `transactionalSends` when it is done.
 */
export const sweepStuckQueuedSends = internalMutation({
	args: {
		table: v.optional(sendTableValidator),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		const table = args.table ?? 'emailSends';
		const now = Date.now();
		const cutoff = now - STUCK_SEND_AGE_MS;
		const pageOptions = { numItems: PAGE_SIZE, cursor: args.cursor ?? null };
		const page =
			table === 'emailSends'
				? await ctx.db
						.query('emailSends')
						.withIndex('by_status', (q) => q.eq('status', 'queued').lt('_creationTime', cutoff))
						.paginate(pageOptions)
				: await ctx.db
						.query('transactionalSends')
						.withIndex('by_status', (q) => q.eq('status', 'queued').lt('_creationTime', cutoff))
						.paginate(pageOptions);

		let terminalized = 0;
		for (const send of page.page as Array<Doc<'emailSends'> | Doc<'transactionalSends'>>) {
			if (send.providerMessageId) continue;
			if ((send.queuedAt ?? send._creationTime) >= cutoff) continue;
			const sendRef =
				table === 'emailSends'
					? { kind: 'campaign' as const, id: send._id as Doc<'emailSends'>['_id'] }
					: { kind: 'transactional' as const, id: send._id as Doc<'transactionalSends'>['_id'] };
			try {
				const outcome = await ctx.runMutation(internal.delivery.sendLifecycle.transition, {
					send: sendRef,
					transition: {
						to: 'failed',
						at: now,
						errorMessage: STUCK_SEND_ERROR_MESSAGE,
						errorCode: STUCK_SEND_ERROR_CODE,
					},
				});
				if (!outcome.ok) continue;
				terminalized += 1;
				await supersedeCompletionFailures(ctx, sendRef.id, now);
			} catch {
				// The lifecycle refused to write; the next sweep tries again. One
				// row must not stop the page.
				logError('[StuckSendSweep] Could not terminalize a stuck send', {
					table,
					sendId: send._id,
				});
			}
		}
		if (terminalized > 0) {
			logWarn('[StuckSendSweep] Terminalized queued sends with no outcome', {
				table,
				terminalized,
			});
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.delivery.stuckSendSweep.sweepStuckQueuedSends, {
				table,
				cursor: page.continueCursor,
			});
		} else if (table === 'emailSends') {
			await ctx.scheduler.runAfter(0, internal.delivery.stuckSendSweep.sweepStuckQueuedSends, {
				table: 'transactionalSends',
				cursor: null,
			});
		}
		return { terminalized };
	},
});
