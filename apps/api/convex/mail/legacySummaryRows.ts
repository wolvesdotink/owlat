/**
 * The rows the retired thread summaries left behind (ADR-0072): Answer mode's
 * catch-up cards (`threadCatchUps`), Today's one-sentence summaries
 * (`todayThreadSummaries`) and the reader strip's `mailThreads.summaryCache`.
 * Nothing writes or reads them any more; the thread brief replaced all three.
 *
 * They stay in the schema for one release (CONVENTIONS "Expand, migrate,
 * contract"): migration 0067 empties them, the release after drops the tables
 * and the field, and this module goes with them. Until then the paths that
 * delete a thread still delete its catch-up cards, because they retell its
 * mail. Helpers only, no Convex functions.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** Delete a Postbox thread's catch-up cards (one per interface locale). */
export async function deleteMailThreadCatchUps(
	ctx: Pick<MutationCtx, 'db'>,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const rows = await ctx.db
		.query('threadCatchUps')
		.withIndex('by_mail_thread_and_locale', (q) => q.eq('mailThreadId', threadId))
		.collect(); // bounded: one row per interface locale
	for (const row of rows) await ctx.db.delete(row._id);
}
