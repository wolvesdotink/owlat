/**
 * Retention sweep shared by every external-reputation ingest path (Google
 * Postmaster, Microsoft SNDS).
 *
 * All of them store one row per subject per UTC day behind a `by_period` index,
 * so all of them retire rows the same way: scan the days older than the horizon,
 * take a bounded page, delete it, and reschedule when the page came back full.
 * Only the typed `.query(table).withIndex(...)` differs, so that is the one part
 * the caller supplies.
 */

import type { Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** The minimum a swept row has to be: something with an id we can delete. */
type ExpirableRow = { readonly _id: Id<TableNames> };

/** One table's page of rows older than `horizon`, at most `limit` of them. */
export type ExpiredObservationScan = (
	horizon: number,
	limit: number
) => Promise<readonly ExpirableRow[]>;

export interface ObservationSweepResult {
	deleted: number;
	continuationScheduled: boolean;
}

/**
 * Delete one bounded page from each table and reschedule if any came back full.
 *
 * A full page means "there is probably more", not "there is definitely more" —
 * the extra empty pass costs one indexed read and keeps the loop terminating on
 * a simple, checkable condition.
 */
export async function sweepExpiredObservations(
	ctx: MutationCtx,
	args: {
		now: number;
		retentionMs: number;
		batchSize: number;
		scans: readonly ExpiredObservationScan[];
		/** Re-run the caller's own cleanup mutation. Return value is ignored. */
		scheduleContinuation: () => Promise<unknown>;
	}
): Promise<ObservationSweepResult> {
	const horizon = args.now - args.retentionMs;
	let deleted = 0;
	let hasMore = false;
	for (const scan of args.scans) {
		const expired = await scan(horizon, args.batchSize);
		for (const row of expired) await ctx.db.delete(row._id);
		deleted += expired.length;
		hasMore ||= expired.length === args.batchSize;
	}
	if (hasMore) await args.scheduleContinuation();
	return { deleted, continuationScheduled: hasMore };
}
