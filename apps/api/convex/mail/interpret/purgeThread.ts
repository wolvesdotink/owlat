/**
 * Thread brief erasure, the thread level (SPEC §5 "Erasure"): when a thread is
 * deleted, every row of the thread brief tables that names it goes, and so do
 * the links into its items from outside them (`purgeLinks.ts`), each item's
 * links cleared before the item.
 *
 * A `thread` purge job (`purgeDrain.ts`) drains the per-thread ranges
 * (`purgeRows.ts threadBriefRanges`) in order, children first, the brief row
 * that holds the deletion epoch last. The epoch is bumped when the job
 * starts, so an interpretation that loaded the thread before cannot write
 * back. Every handled row is deleted, so the ranges need no cursor.
 */

import type { MutationCtx } from '../../_generated/server';
import type { ThreadRefKind } from '@owlat/shared/threadBrief';
import type { BriefRow } from './purgeRows';
import { threadBriefRanges } from './purgeRows';
import { drainFactLinks, drainItemLinks } from './purgeLinks';
import { drainShrinking, type JobPlan, type PurgeRange, type RangeRun } from './purgeDrain';
import type { Doc } from '../../_generated/dataModel';

function isItemRow(row: BriefRow): row is Doc<'threadItems'> {
	return 'disposition' in row && 'evidence' in row;
}

function isFactRow(row: BriefRow): row is Doc<'threadFacts'> {
	return 'factKeyHash' in row || 'factKey' in row;
}

/** Delete one thread brief row of a deleted thread, its links first; false when out of budget. */
async function deleteRow(ctx: MutationCtx, run: RangeRun, row: BriefRow): Promise<boolean> {
	if (isItemRow(row)) {
		if (!(await drainItemLinks(ctx, run.ref, row, run.budget, { isThreadGone: true })))
			return false;
	} else if (isFactRow(row)) {
		if (!(await drainFactLinks(ctx, row, run.budget, { isThreadGone: true }))) return false;
	}
	await ctx.db.delete(row._id);
	return true;
}

/** The `index`-th per-thread range, drained. */
function threadRange(index: number): PurgeRange {
	return async (ctx, run) => {
		const read = threadBriefRanges(ctx, run.ref)[index]!;
		const isEmpty = await drainShrinking(run.budget, read, (row) => deleteRow(ctx, run, row));
		return isEmpty ? { isDone: true } : { isDone: false, cursor: undefined };
	};
}

/** Settle: a Postbox thread that outlived its brief keeps no projection of it. */
async function settleThreadJob(ctx: MutationCtx, _job: unknown, ref: RangeRun['ref']) {
	if (ref.kind !== 'mail') return;
	const thread = await ctx.db.get(ref.id);
	if (thread?.briefTop) await ctx.db.patch(ref.id, { briefTop: undefined });
}

/** How many per-thread ranges a thread of `kind` has (the readers are built, never called). */
function rangeCount(kind: ThreadRefKind): number {
	const probe = { kind, id: '' } as RangeRun['ref'];
	return threadBriefRanges({} as MutationCtx, probe).length;
}

/** The walk of a `thread` job. */
export function threadPlan(kind: ThreadRefKind): JobPlan {
	return {
		ranges: Array.from({ length: rangeCount(kind) }, (_, i) => threadRange(i)),
		settle: settleThreadJob,
	};
}
