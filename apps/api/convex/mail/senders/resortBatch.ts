/**
 * Sender-wide re-sorts within Convex transaction limits (SPEC §16).
 *
 * A sender's status or override is an input of every one of its threads'
 * projections. Recomputing all of its newest ≤200 Inbox threads in the
 * mutation that changed the input can, several senders at a time, exceed the
 * 4,096 index ranges one function may read. So the changing mutation
 * recomputes the first {@link RESORT_INLINE_THREADS} itself, and a bounded
 * continuation chain (`./resortChain.ts continueResort`) recomputes the rest of the SAME
 * set, snapshotted when the input changed: newer threads pick up the input
 * when they are written anyway. An undo that started a chain passes its
 * operation, and stays `isDone: false` until the chain's last batch ran
 * (`mail/arrival/undoProgress.ts`).
 */

import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { refreshArrivalProjection } from '../arrival/projection';

/** Threads one mutation recomputes: about 20 projections fit the read budget many times over. */
export const RESORT_INLINE_THREADS = 20;

/**
 * Recompute the first batch of `threadIds` now and chain the rest. Returns
 * whether a chain was started (it then owns calling `finishUndoResort`).
 */
export async function refreshThreadsBounded(
	ctx: MutationCtx,
	threadIds: readonly Id<'mailThreads'>[],
	opts: { undoOperationId?: Id<'mailArrivalOperations'> } = {}
): Promise<{ isContinued: boolean }> {
	for (const threadId of threadIds.slice(0, RESORT_INLINE_THREADS)) {
		await refreshArrivalProjection(ctx, threadId);
	}
	const rest = threadIds.slice(RESORT_INLINE_THREADS);
	if (rest.length === 0) return { isContinued: false };
	await ctx.scheduler.runAfter(0, internal.mail.senders.resortChain.continueResort, {
		threadIds: rest,
		...(opts.undoOperationId ? { undoOperationId: opts.undoOperationId } : {}),
	});
	return { isContinued: true };
}
