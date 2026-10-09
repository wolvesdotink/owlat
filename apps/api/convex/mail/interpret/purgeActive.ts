/**
 * Unfinished purge jobs of a thread (final review r2, F1). A purge runs in
 * budgeted slices (`purgeDrain.ts`); between its start and its last slice the
 * thread holds claims it has not redacted yet, while the surviving messages'
 * extractions still read complete. So:
 *
 *   - `syncActivePurgeJobs` keeps `threadBriefs.activePurgeJobs` equal to the
 *     thread's job rows (counted through the index, so a lost update heals at
 *     the next start or finish) and rewrites completeness through the one
 *     rule (`purgeRepairs.briefCompleteness`: partial while it is non-zero);
 *   - `isPurgeActive` is the indexed lookup the D3 hold reads, in the route
 *     gate and again in the transaction that creates an autonomous Send.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { loadBriefRow } from './briefRow';
import { briefCompleteness } from './purgeRepairs';

/** Jobs counted per thread; more is "many", which is all the brief needs. */
const ACTIVE_JOB_SCAN = 50;

function jobsOf(ctx: Pick<QueryCtx, 'db'>, ref: ThreadRef, limit: number) {
	return ref.kind === 'mail'
		? ctx.db
				.query('threadPurgeJobs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', ref.id))
				.take(limit)
		: ctx.db
				.query('threadPurgeJobs')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', ref.id))
				.take(limit);
}

/** Does any purge job of the thread still run? One indexed read. */
export async function isPurgeActive(ctx: Pick<QueryCtx, 'db'>, ref: ThreadRef): Promise<boolean> {
	return (await jobsOf(ctx, ref, 1)).length > 0;
}

/**
 * Bring the brief's job count (and its completeness) in line with the job
 * rows; call after a job is created and after one is deleted, in the same
 * transaction. A thread with no brief row needs nothing.
 */
export async function syncActivePurgeJobs(ctx: MutationCtx, ref: ThreadRef): Promise<void> {
	const brief = await loadBriefRow(ctx, ref);
	if (!brief) return;
	const activePurgeJobs = (await jobsOf(ctx, ref, ACTIVE_JOB_SCAN)).length;
	if ((brief.activePurgeJobs ?? 0) === activePurgeJobs) return;
	await ctx.db.patch(brief._id, {
		activePurgeJobs,
		...(brief.completeness === 'pending'
			? {}
			: { completeness: briefCompleteness({ ...brief, activePurgeJobs }) }),
		updatedAt: Date.now(),
	});
}
