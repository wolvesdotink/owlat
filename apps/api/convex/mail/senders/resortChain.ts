/**
 * The continuation of a sender-wide re-sort: each batch is one
 * mutation over the next part of the snapshotted thread set, scheduled by
 * `./resortBatch.ts refreshThreadsBounded`. The last batch of a chain an undo
 * started reports to that undo's progress.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import { finishUndoResort } from '../arrival/undoProgress';
import { refreshThreadsBounded } from './resortBatch';

/** The next batch of a sender-wide re-sort (scheduled by `refreshThreadsBounded`). */
export const continueResort = internalMutation({
	args: {
		threadIds: v.array(v.id('mailThreads')),
		undoOperationId: v.optional(v.id('mailArrivalOperations')),
	},
	handler: async (ctx, args): Promise<void> => {
		const { isContinued } = await refreshThreadsBounded(
			ctx,
			args.threadIds,
			args.undoOperationId ? { undoOperationId: args.undoOperationId } : {}
		);
		if (!isContinued && args.undoOperationId) await finishUndoResort(ctx, args.undoOperationId);
	},
});
