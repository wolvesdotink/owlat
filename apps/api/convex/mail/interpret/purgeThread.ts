/**
 * Thread brief erasure, the thread level (SPEC §5 "Erasure"): when a thread is
 * deleted, every row of the seven thread brief tables that names it goes, and
 * so do the links into its items from outside them (`purgeRows.ts`).
 *
 * `purgeThreadBrief` runs inline in the transaction that deletes the thread
 * (a Postbox thread losing its last message in `rebuildThreadAggregates`, an
 * external account's teardown) up to a row bound, and hands what is left to
 * `drainThreadBrief`, a self-rescheduling continuation that finds the rows by
 * the thread id alone (the thread row is gone by then). The deletion epoch is
 * bumped first, and the brief row that holds it goes last, so an
 * interpretation that loaded the thread before cannot write back.
 *
 * The erasure walkers do not call this: they drain the same ranges within
 * their own budget (`threadBriefRanges` + `deleteThreadBriefRow`).
 */

import { internal } from '../../_generated/api';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { threadRefValidator, type ThreadRef } from '../../lib/validators/threadRef';
import {
	bumpDeletionEpoch,
	deleteThreadBriefRow,
	NO_METER,
	threadBriefRanges,
	type PurgeMeter,
} from './purgeRows';

/** Rows a purge deletes inline, in the caller's transaction. */
export const INLINE_THREAD_PURGE_ROWS = 256;
/** Rows one continuation transaction deletes. */
const DRAIN_ROWS = 512;
/** Rows read per range at a time. */
const READ_CHUNK = 64;

/**
 * Delete up to `limit` of the thread's brief rows, children first. Returns
 * whether none is left.
 */
export async function deleteThreadBriefRows(
	ctx: MutationCtx,
	ref: ThreadRef,
	limit: number,
	meter: PurgeMeter = NO_METER
): Promise<boolean> {
	let left = limit;
	for (const read of threadBriefRanges(ctx, ref)) {
		for (;;) {
			if (left <= 0) return false;
			const take = Math.min(READ_CHUNK, left);
			const rows = await read(take);
			for (const row of rows) {
				meter(row);
				await deleteThreadBriefRow(ctx, row, meter);
			}
			left -= rows.length;
			if (rows.length < take) break;
		}
	}
	return true;
}

/**
 * Purge a thread's brief: bump the deletion epoch, delete up to `inlineRows`
 * rows now and schedule the rest. Call it in the transaction that deletes the
 * thread; a caller deleting many threads at once passes a smaller bound.
 */
export async function purgeThreadBrief(
	ctx: MutationCtx,
	ref: ThreadRef,
	inlineRows: number = INLINE_THREAD_PURGE_ROWS
): Promise<void> {
	await bumpDeletionEpoch(ctx, ref);
	const isDone = await deleteThreadBriefRows(ctx, ref, inlineRows);
	if (!isDone) {
		await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeThread.drainThreadBrief, {
			threadRef: ref,
		});
	}
}

/** Continuation of {@link purgeThreadBrief}: one bounded batch, then itself again. */
export const drainThreadBrief = internalMutation({
	args: { threadRef: threadRefValidator },
	handler: async (ctx, args): Promise<{ isDone: boolean }> => {
		const isDone = await deleteThreadBriefRows(ctx, args.threadRef, DRAIN_ROWS);
		if (!isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeThread.drainThreadBrief, args);
		}
		return { isDone };
	},
});
