/**
 * The brief's maintained counters (review F3, F4), on `threadBriefs`:
 *
 *   - `sourceCounts`: one bucket per source message, for its CURRENT
 *     extraction (`messageInterpretations.isCurrent`). Completeness and the
 *     incomplete banner read these, so an old unresolved failure is never
 *     lost behind newer rows.
 *   - `itemCounts`: open items per responsibility, closed, untracked. The
 *     brief's counts read these, so a long thread is never undercounted.
 *
 * Every writer that changes an extraction's status or an item's status or
 * responsibility adjusts them in the same transaction: the reducer does;
 * reactions and send hooks outside it call {@link recordItemChange}.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { BriefCompleteness } from '@owlat/shared/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { ensureBriefRow } from './briefRow';

export type SourceCounts = NonNullable<Doc<'threadBriefs'>['sourceCounts']>;
export type ItemCounts = NonNullable<Doc<'threadBriefs'>['itemCounts']>;
export type SourceBucket = keyof SourceCounts;
export type ItemBucket = keyof ItemCounts;

export const EMPTY_SOURCE_COUNTS: SourceCounts = {
	complete: 0,
	partial: 0,
	failed: 0,
	unreadable: 0,
	skipped: 0,
};
export const EMPTY_ITEM_COUNTS: ItemCounts = { us: 0, them: 0, unclear: 0, closed: 0, hidden: 0 };

/** The bucket an extraction counts in. Pure. */
export function sourceBucketOf(
	row: Pick<Doc<'messageInterpretations'>, 'status' | 'skipReason'>
): SourceBucket {
	if (row.status === 'skipped') return row.skipReason === 'undecryptable' ? 'unreadable' : 'skipped';
	return row.status;
}

/** Completeness from the source counters. Pure. */
export function completenessOfCounts(counts: SourceCounts): BriefCompleteness {
	if (counts.partial + counts.failed + counts.unreadable > 0) return 'partial';
	if (counts.complete + counts.skipped > 0) return 'complete';
	return 'none';
}

/** The bucket an item counts in. Pure. */
export function itemBucketOf(
	item: Pick<Doc<'threadItems'>, 'status' | 'responsibility'>
): ItemBucket {
	if (item.status === 'open') return item.responsibility;
	if (item.status === 'untracked') return 'hidden';
	return 'closed';
}

/** Counters after moving one entry from `before` to `after` (null = absent). Pure. */
export function shiftCount<K extends string>(
	counts: Record<K, number>,
	before: K | null,
	after: K | null
): Record<K, number> {
	if (before === after) return counts;
	const next = { ...counts };
	if (before !== null) next[before] = Math.max(0, next[before] - 1);
	if (after !== null) next[after] = next[after] + 1;
	return next;
}

/**
 * Adjust the item counters for one item change (insert: `before` null; status
 * or responsibility change: both). Writers outside the reducer call this in
 * the transaction of the change.
 */
export async function recordItemChange(
	ctx: MutationCtx,
	ref: ThreadRef,
	before: Pick<Doc<'threadItems'>, 'status' | 'responsibility'> | null,
	after: Pick<Doc<'threadItems'>, 'status' | 'responsibility'> | null
): Promise<void> {
	const from = before ? itemBucketOf(before) : null;
	const to = after ? itemBucketOf(after) : null;
	if (from === to) return;
	const brief = await ensureBriefRow(ctx, ref);
	if (!brief) return;
	await ctx.db.patch(brief._id, {
		itemCounts: shiftCount(brief.itemCounts ?? EMPTY_ITEM_COUNTS, from, to),
	});
}

/** Apply a batch of item bucket moves to a brief row in one patch. */
export async function applyItemShifts(
	ctx: MutationCtx,
	briefId: Id<'threadBriefs'>,
	shifts: ReadonlyArray<[ItemBucket | null, ItemBucket | null]>
): Promise<ItemCounts> {
	const brief = await ctx.db.get(briefId);
	let counts = brief?.itemCounts ?? EMPTY_ITEM_COUNTS;
	for (const [from, to] of shifts) counts = shiftCount(counts, from, to);
	await ctx.db.patch(briefId, { itemCounts: counts });
	return counts;
}
