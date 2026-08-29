/**
 * Attachment share links (plan idea 10) — the EXPIRY sweep.
 *
 * Server-side expiry is the whole reason a share link is safe to hand out. The
 * serving route already refuses a lapsed token, so this sweep is not what makes
 * an expired link stop working — it is what makes the FILE stop existing.
 * Without it, "expires in 14 days" would mean "becomes unreachable through one
 * route in 14 days, and sits in storage forever", which is neither the promise
 * the UI makes nor a defensible thing to do with someone's data.
 *
 * TWO PHASES, deliberately separated in time:
 *
 *   1. The bytes go the moment a link lapses. Storage is reclaimed, and there
 *      is nothing left to leak even if a future bug weakened the route.
 *   2. The ROW goes a grace window later — `isAttachmentSharePurgeable` owns
 *      the deadline. It is what lets the settings list answer "what happened to
 *      that link?" for the month after it dies, which is exactly when someone
 *      asks.
 *
 * Bounded per tick and resumable: the `by_expiry` index is walked in expiry
 * order and stopped at `now`, so a tick's work is proportional to what actually
 * lapsed rather than to the size of the table, and a backlog drains over
 * successive runs instead of blowing one mutation's budget. Revoked rows are
 * NOT reached this way (a revoke already released their bytes and its own
 * `expiresAt` may be far in the future) — they are purged by the same walk once
 * their untouched expiry finally arrives, or immediately if it already had.
 */

import { v } from 'convex/values';
import { isAttachmentSharePurgeable } from '@owlat/shared/attachmentShares';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { releaseShareBytes } from './attachmentShares';

/** Lapsed rows examined per sweep run. The next tick continues where it stopped. */
export const ATTACHMENT_SHARE_SWEEP_BATCH = 64;

/**
 * Release the bytes of every share whose expiry has passed, then delete the
 * records that have sat byte-less through the grace window.
 *
 * Idempotent: a row whose bytes are already gone is skipped by
 * `releaseShareBytes`'s own guard, so a retried or overlapping tick does no
 * damage and no double work.
 */
export const sweepExpiredShares = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (
		ctx,
		args
	): Promise<{
		examined: number;
		released: number;
		purged: number;
		continuationScheduled: boolean;
	}> => {
		const now = Date.now();
		// Everything at or before `now` has lapsed; the index ordering means the
		// walk stops as soon as it reaches links that are still live.
		const page = await ctx.db
			.query('mailAttachmentShares')
			.withIndex('by_expiry', (q) => q.lte('expiresAt', now))
			.paginate({ cursor: args.cursor ?? null, numItems: ATTACHMENT_SHARE_SWEEP_BATCH });

		let released = 0;
		let purged = 0;
		for (const row of page.page) {
			if (row.storageId) {
				await releaseShareBytes(ctx, row, {});
				released++;
				// Freshly released: it has not served its grace window yet, and the
				// patch above already moved it out of the "still has bytes" set.
				continue;
			}
			if (isAttachmentSharePurgeable({ ...row, hasBytes: false }, now)) {
				await ctx.db.delete(row._id);
				purged++;
			}
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.attachmentShareRetention.sweepExpiredShares, {
				cursor: page.continueCursor,
			});
		}
		return {
			examined: page.page.length,
			released,
			purged,
			continuationScheduled: !page.isDone,
		};
	},
});
