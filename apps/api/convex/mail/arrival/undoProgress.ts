/**
 * Read on arrival, Undo progress (SPEC §4.4, §16): the running totals an undo
 * keeps on its operation header (`undoProgress`), shared by the undo pages
 * (`./operations.ts`) and the sender re-sort chains they start
 * (`mail/senders/resortChain.ts`). An undo is done when its last page ran and
 * no chain it started is still running.
 *
 * A leaf: isolate-safe helpers, no Convex functions.
 */

import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { UndoProgress } from '../../lib/validators/arrival';

export const EMPTY_UNDO_PROGRESS: UndoProgress = {
	restored: 0,
	skipped: 0,
	isNeedsReplyCleared: false,
	isPagingDone: false,
	pendingResorts: 0,
	isDone: false,
};

/** `previous` plus one page's outcome. Pure. */
export function addUndoPage(
	previous: UndoProgress | undefined,
	page: {
		restored: number;
		skipped: number;
		isNeedsReplyCleared: boolean;
		isLastPage: boolean;
		startedResorts: number;
	}
): UndoProgress {
	const base = previous ?? EMPTY_UNDO_PROGRESS;
	const isPagingDone = page.isLastPage;
	const pendingResorts = base.pendingResorts + page.startedResorts;
	return {
		restored: base.restored + page.restored,
		skipped: base.skipped + page.skipped,
		isNeedsReplyCleared: base.isNeedsReplyCleared || page.isNeedsReplyCleared,
		isPagingDone,
		pendingResorts,
		isDone: isPagingDone && pendingResorts === 0,
	};
}

/** One re-sort chain an undo started has finished its last batch. */
export async function finishUndoResort(
	ctx: MutationCtx,
	operationId: Id<'mailArrivalOperations'>
): Promise<void> {
	const operation = await ctx.db.get(operationId);
	if (!operation?.undoProgress) return;
	const pendingResorts = Math.max(0, operation.undoProgress.pendingResorts - 1);
	await ctx.db.patch(operationId, {
		undoProgress: {
			...operation.undoProgress,
			pendingResorts,
			isDone: operation.undoProgress.isPagingDone && pendingResorts === 0,
		},
	});
}
