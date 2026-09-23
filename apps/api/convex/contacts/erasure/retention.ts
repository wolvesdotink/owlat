/**
 * The soft-delete retention sweep: hands contacts whose 30-day grace has run
 * out to the erasure walker, and restarts erasures that stopped moving.
 *
 * Selection is an index RANGE on `by_deleted_at` — `deletedAt` in
 * `[0, cutoff)` — so the sweep reads exactly the rows it returns. Live contacts
 * (`deletedAt` absent) sort before every number and fall outside the range;
 * the old post-filter read them all before `take` could stop it.
 */

import type { DatabaseReader, MutationCtx } from '../../_generated/server';
import type { Doc } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import { startContactErasure } from './walker';

/** A `running` or `retrying` job untouched this long has lost its chain. */
const STALLED_AFTER_MS = 30 * 60 * 1000;
/** Stalled or failed jobs restarted per sweep, per status. */
const RESTARTS_PER_SWEEP = 50;

/**
 * The oldest soft-deleted contacts whose `deletedAt` is before `cutoff`.
 * `deletedAt` is a wall-clock stamp, so 0 is a safe lower bound; it exists to
 * exclude live rows, which have no `deletedAt` and sort first.
 */
export function selectExpiredSoftDeletedContacts(
	db: DatabaseReader,
	cutoff: number,
	limit: number
): Promise<Doc<'contacts'>[]> {
	return db
		.query('contacts')
		.withIndex('by_deleted_at', (q) => q.gte('deletedAt', 0).lt('deletedAt', cutoff))
		.take(limit);
}

/**
 * Re-arm failed jobs and restart chains that went quiet (a crashed action, a
 * lost schedule). Runs from the daily sweep, so a job that keeps failing is
 * retried once a day and stays visible as `failed` with its `lastError`.
 */
async function restartStalledErasures(ctx: MutationCtx, now: number): Promise<number> {
	let restarted = 0;
	for (const status of ['running', 'retrying', 'failed'] as const) {
		const stalled = await ctx.db
			.query('contactErasureJobs')
			.withIndex('by_status_and_updated_at', (q) =>
				q.eq('status', status).lt('updatedAt', now - STALLED_AFTER_MS)
			)
			.take(RESTARTS_PER_SWEEP);
		for (const job of stalled) {
			await ctx.db.patch(job._id, {
				status: 'running',
				updatedAt: now,
				...(status === 'failed' ? { attempts: 0 } : {}),
			});
			await ctx.scheduler.runAfter(0, internal.contacts.erasure.walker.drive, { jobId: job._id });
			restarted += 1;
		}
	}
	return restarted;
}

export async function sweepContactRetention(
	ctx: MutationCtx,
	args: { cutoff: number; limit: number }
): Promise<{ started: number; restarted: number }> {
	const now = Date.now();
	// Restart first: a job this sweep starts must not be mistaken for stalled.
	const restarted = await restartStalledErasures(ctx, now);
	const expired = await selectExpiredSoftDeletedContacts(ctx.db, args.cutoff, args.limit);
	let started = 0;
	for (const contact of expired) {
		if (await startContactErasure(ctx, contact._id, 'retention')) started += 1;
	}
	return { started, restarted };
}
