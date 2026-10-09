/**
 * Outstanding purge repairs (review round 4, F5). After a purge redacted a
 * claim, every surviving source is re-read (`purgeQuestions.ts`
 * `reinterpretRange`): its counted extraction is MARKED (`errorCode:
 * 'purge_recheck'`, retry due now) and its interpretation scheduled. The mark
 * is the token: `threadBriefs.pendingRepairs` counts the marked counted rows
 * of the thread, and moves exactly when a mark is set or goes:
 *
 *  - set: {@link markRepair} (+1, only on a row not marked yet);
 *  - gone: the repair's run records its result over the marked row
 *    (`reduce.ts`, same transaction), the run is refused as `erased`
 *    (`reduce.ts`; the mark is cleared so it cannot leak), or a later purge
 *    deletes the marked row (`purgeRows.ts deleteExtractions`): -1 each.
 *
 * Completeness reads the counter with the source counters in ONE place,
 * {@link briefCompleteness}: partial while any repair is outstanding.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { BriefCompleteness } from '@owlat/shared/threadBrief';
import { EMPTY_SOURCE_COUNTS, completenessOfCounts, shiftCount, sourceBucketOf } from './counters';

/** The machine reason on a counted extraction marked for a re-read after a purge. */
export const PURGE_RECHECK_CODE = 'purge_recheck';

export function isRepairMarked(row: Pick<Doc<'messageInterpretations'>, 'errorCode'>): boolean {
	return row.errorCode === PURGE_RECHECK_CODE;
}

/**
 * The brief's completeness, the one rule every stored write and both
 * auto-send gates read: partial while a repair, a pending-transition scan or
 * a cut fold is outstanding, else what its source counters say; and a
 * complete brief whose earlier history is still being read (pages left, or
 * admitted sources not yet recorded) or cannot be read back
 * (`backfillSources.ts`), is partial too. Pure.
 */
export function briefCompleteness(
	brief: Pick<
		Doc<'threadBriefs'>,
		| 'sourceCounts'
		| 'pendingRepairs'
		| 'pendingMatchRuns'
		| 'isFoldScanCut'
		| 'historyState'
		| 'isHistoryIncomplete'
		| 'pendingSources'
		| 'unreadSources'
	>
): BriefCompleteness {
	// A source the stale sweep gave up on: partial, whatever else was read.
	if ((brief.unreadSources ?? 0) > 0) return 'partial';
	if ((brief.pendingRepairs ?? 0) > 0) return 'partial';
	if ((brief.pendingMatchRuns ?? 0) > 0 || brief.isFoldScanCut === true) return 'partial';
	const counted = completenessOfCounts(brief.sourceCounts ?? EMPTY_SOURCE_COUNTS);
	// Runs still out: `pending` while nothing is recorded yet, else partial.
	if ((brief.pendingSources ?? 0) > 0) return counted === 'none' ? 'pending' : 'partial';
	const isHistoryOpen = brief.historyState === 'pending' || brief.isHistoryIncomplete === true;
	return counted === 'complete' && isHistoryOpen ? 'partial' : counted;
}

/** Move the brief's repair counter by `delta` (never below zero) and its completeness with it. */
export async function shiftPendingRepairs(
	ctx: MutationCtx,
	briefId: Id<'threadBriefs'>,
	delta: number
): Promise<void> {
	const brief = await ctx.db.get(briefId);
	if (!brief) return;
	const pendingRepairs = Math.max(0, (brief.pendingRepairs ?? 0) + delta);
	await ctx.db.patch(briefId, {
		pendingRepairs: pendingRepairs > 0 ? pendingRepairs : undefined,
		completeness: briefCompleteness({ ...brief, pendingRepairs }),
	});
}

/**
 * Mark a counted extraction for its purge repair: `partial`, retry due now,
 * its source counter moved, the brief's repair counter raised (once per
 * mark) and the brief partial. Returns whether a repair should be scheduled.
 */
export async function markRepair(
	ctx: MutationCtx,
	brief: Doc<'threadBriefs'>,
	counted: Doc<'messageInterpretations'>
): Promise<void> {
	const isNew = !isRepairMarked(counted);
	await ctx.db.patch(counted._id, {
		status: 'partial',
		errorCode: PURGE_RECHECK_CODE,
		nextRetryAt: Date.now(),
		updatedAt: Date.now(),
	});
	const sourceCounts = shiftCount(
		brief.sourceCounts ?? EMPTY_SOURCE_COUNTS,
		sourceBucketOf(counted),
		'partial'
	);
	const pendingRepairs = (brief.pendingRepairs ?? 0) + (isNew ? 1 : 0);
	await ctx.db.patch(brief._id, {
		sourceCounts,
		pendingRepairs,
		completeness: briefCompleteness({ ...brief, sourceCounts, pendingRepairs }),
	});
}

/**
 * A repair run refused as `erased` (a later purge ran meanwhile): clear its
 * mark so the counter cannot leak; the row stays `partial` (the read did not
 * happen), which its source counter already says.
 */
export async function abandonRepair(
	ctx: MutationCtx,
	briefId: Id<'threadBriefs'>,
	counted: Doc<'messageInterpretations'> | null
): Promise<void> {
	if (!counted || !isRepairMarked(counted)) return;
	await ctx.db.patch(counted._id, { errorCode: 'purge_recheck_abandoned', nextRetryAt: undefined });
	await shiftPendingRepairs(ctx, briefId, -1);
}
