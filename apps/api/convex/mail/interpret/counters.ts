/**
 * The brief's maintained counters (review F3, F4), on `threadBriefs`:
 *
 *   - `sourceCounts`: one bucket per source message, for its CURRENT
 *     extraction (`messageInterpretations.isCurrent`). Completeness and the
 *     incomplete banner read these, so an old unresolved failure is never
 *     lost behind newer rows.
 *   - `itemCounts`: open items per responsibility, unconfirmed proposals
 *     ("Check this", any responsibility), closed, untracked. The brief's
 *     counts and the list row (`briefTop.ts`) read these, so a long thread is
 *     never undercounted and a proposal never counts as tracked work.
 *
 * Every item also carries `listBucket` ({@link listBucketOf}), the same
 * partition under the brief's list names, so the list row reads the first
 * item of a list from an index (`by_mail_thread_bucket_sort`, on `sortKey`).
 *
 * Every writer that changes an extraction's status or an item's status,
 * responsibility or verify state adjusts them in the same transaction: the
 * reducer does (`reduceWrite.ts`); reactions and send hooks outside it call
 * {@link writeItemChange} (patch + bucket + counters in one call) or, for an
 * insert / delete, {@link recordItemChange} with the stored `listBucket`.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { BriefCompleteness } from '@owlat/shared/threadBrief';
import { forYouSortKey } from '@owlat/shared/threadBriefRules';
import type { ItemListBucket } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { ensureBriefRow } from './briefRow';

export type SourceCounts = NonNullable<Doc<'threadBriefs'>['sourceCounts']>;
export type ItemCounts = Required<NonNullable<Doc<'threadBriefs'>['itemCounts']>>;
export type SourceBucket = keyof SourceCounts;
export type ItemBucket = keyof ItemCounts;

export const EMPTY_SOURCE_COUNTS: SourceCounts = {
	complete: 0,
	partial: 0,
	failed: 0,
	unreadable: 0,
	skipped: 0,
};
export const EMPTY_ITEM_COUNTS: ItemCounts = {
	us: 0,
	them: 0,
	unclear: 0,
	proposal: 0,
	closed: 0,
	hidden: 0,
};

/** A brief row's item counters, fields written before they existed read as 0. Pure. */
export function itemCountsOf(brief: Pick<Doc<'threadBriefs'>, 'itemCounts'> | null): ItemCounts {
	return { ...EMPTY_ITEM_COUNTS, ...brief?.itemCounts };
}

/** The bucket an extraction counts in. Pure. */
export function sourceBucketOf(
	row: Pick<Doc<'messageInterpretations'>, 'status' | 'skipReason'>
): SourceBucket {
	if (row.status === 'skipped')
		return row.skipReason === 'undecryptable' ? 'unreadable' : 'skipped';
	return row.status;
}

/** Completeness from the source counters. Pure. */
export function completenessOfCounts(counts: SourceCounts): BriefCompleteness {
	if (counts.partial + counts.failed + counts.unreadable > 0) return 'partial';
	if (counts.complete + counts.skipped > 0) return 'complete';
	return 'none';
}

/** What decides an item's bucket; `verify` absent reads as tracked. */
export type ItemBucketFields = Pick<Doc<'threadItems'>, 'status' | 'responsibility'> & {
	verify?: Doc<'threadItems'>['verify'];
};

/** The bucket an item counts in: an open unconfirmed proposal apart from tracked work. Pure. */
export function itemBucketOf(item: ItemBucketFields): ItemBucket {
	if (item.status === 'open') return item.verify === 'proposal' ? 'proposal' : item.responsibility;
	if (item.status === 'untracked') return 'hidden';
	return 'closed';
}

const LIST_BUCKET: Record<ItemBucket, ItemListBucket> = {
	us: 'forUs',
	them: 'waitingOnOthers',
	unclear: 'unclear',
	proposal: 'proposal',
	closed: 'closed',
	hidden: 'closed',
};

/** An item's stored "For you" order key (`threadItems.sortKey`). Pure. */
export function itemSortKey(
	item: Pick<Doc<'threadItems'>, '_id' | 'due' | 'facets' | 'askedAt'>
): string {
	return forYouSortKey({ due: item.due, facets: item.facets, askedAt: item.askedAt, id: item._id });
}

/** The brief list an item sits in (`threadItems.listBucket`). Pure. */
export function listBucketOf(item: ItemBucketFields): ItemListBucket {
	return LIST_BUCKET[itemBucketOf(item)];
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
	before: ItemBucketFields | null,
	after: ItemBucketFields | null
): Promise<void> {
	const from = before ? itemBucketOf(before) : null;
	const to = after ? itemBucketOf(after) : null;
	if (from === to) return;
	const brief = await ensureBriefRow(ctx, ref);
	if (!brief) return;
	await ctx.db.patch(brief._id, { itemCounts: shiftCount(itemCountsOf(brief), from, to) });
}

/**
 * THE helper for item writes outside the reducer (reactions, corrections,
 * send hooks): patch the item, keep its `listBucket` and `sortKey` in step
 * and move the thread's counters, in one call and one transaction.
 */
export async function writeItemChange(
	ctx: MutationCtx,
	ref: ThreadRef,
	row: Doc<'threadItems'>,
	patch: Partial<Omit<Doc<'threadItems'>, '_id' | '_creationTime' | 'listBucket' | 'sortKey'>>
): Promise<void> {
	const after: ItemBucketFields = {
		status: patch.status ?? row.status,
		responsibility: patch.responsibility ?? row.responsibility,
		verify: patch.verify ?? row.verify,
	};
	const sortKey = itemSortKey({
		_id: row._id,
		due: 'due' in patch ? patch.due : row.due,
		facets: patch.facets ?? row.facets,
		askedAt: patch.askedAt ?? row.askedAt,
	});
	await ctx.db.patch(row._id, { ...patch, listBucket: listBucketOf(after), sortKey });
	await recordItemChange(ctx, ref, row, after);
}

/** Apply a batch of item bucket moves to a brief row in one patch. */
export async function applyItemShifts(
	ctx: MutationCtx,
	briefId: Id<'threadBriefs'>,
	shifts: ReadonlyArray<[ItemBucket | null, ItemBucket | null]>
): Promise<ItemCounts> {
	const brief = await ctx.db.get(briefId);
	let counts = itemCountsOf(brief);
	for (const [from, to] of shifts) counts = shiftCount(counts, from, to);
	await ctx.db.patch(briefId, { itemCounts: counts });
	return counts;
}
