/**
 * Bounded reads of a thread's items by status and update time, shared by the
 * prompt (`load.ts`), the fold (`reduceState.ts`), the brief and the deferral
 * check. A read that must not see withdrawn items (scopeReconcile.ts) asks
 * the index to skip them, so they never use up its bound.
 */

import type { IndexRange } from 'convex/server';
import type { Doc } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { CLOSED_ITEM_LOOKBACK_MS } from './schema';

type ReadCtx = Pick<QueryCtx, 'db'>;

/** Statuses read as "recently closed" for the prompt. */
export const CLOSED_STATUSES = ['done', 'declined', 'superseded', 'untracked'] as const;

/** Which of a thread's items a read takes. */
interface ItemReadOptions {
	/**
	 * Only items that are not withdrawn (scopeReconcile.ts), excluded by the
	 * index before the bound applies. Only mail threads have withdrawn items.
	 */
	isLiveOnly?: boolean;
}

/** A thread's items of `status` (changed since `since`, when given), by update time. */
function itemsByStatus(
	ctx: ReadCtx,
	ref: ThreadRef,
	status: Doc<'threadItems'>['status'],
	since: number | undefined,
	opts: ItemReadOptions
) {
	const items = ctx.db.query('threadItems');
	type Range = IndexRange & { gte(field: 'updatedAt', value: number): IndexRange };
	const after = (range: Range): IndexRange =>
		since === undefined ? range : range.gte('updatedAt', since);
	if (ref.kind !== 'mail') {
		return items.withIndex('by_conversation_thread_and_status', (q) =>
			after(q.eq('conversationThreadId', ref.id).eq('status', status))
		);
	}
	return opts.isLiveOnly
		? items.withIndex('by_mail_thread_withdrawn', (q) =>
				after(
					q.eq('mailThreadId', ref.id).eq('withdrawal.messageId', undefined).eq('status', status)
				)
			)
		: items.withIndex('by_mail_thread_and_status', (q) =>
				after(q.eq('mailThreadId', ref.id).eq('status', status))
			);
}

/** Read a thread's items with the given status, bounded. */
export async function threadItemsWithStatus(
	ctx: ReadCtx,
	ref: ThreadRef,
	status: Doc<'threadItems'>['status'],
	limit: number,
	opts: ItemReadOptions = {}
): Promise<Doc<'threadItems'>[]> {
	return itemsByStatus(ctx, ref, status, undefined, opts).take(limit);
}

/** A thread's items of `status` changed since `since`, newest first, bounded. */
async function recentlyUpdatedItems(
	ctx: ReadCtx,
	ref: ThreadRef,
	status: Doc<'threadItems'>['status'],
	since: number,
	limit: number,
	opts: ItemReadOptions = {}
): Promise<Doc<'threadItems'>[]> {
	return itemsByStatus(ctx, ref, status, since, opts).order('desc').take(limit);
}

/**
 * Items of `statuses` changed within the closed-item lookback, newest first,
 * read by update time (a long history never hides a recently closed or
 * corrected item). `isCut` says a bound was hit.
 */
export async function recentlyClosedItems(
	ctx: ReadCtx,
	ref: ThreadRef,
	statuses: readonly Doc<'threadItems'>['status'][],
	now: number,
	limitPerStatus: number,
	opts: ItemReadOptions = {}
): Promise<{ rows: Doc<'threadItems'>[]; isCut: boolean }> {
	const since = now - CLOSED_ITEM_LOOKBACK_MS;
	const found = await Promise.all(
		statuses.map((status) =>
			recentlyUpdatedItems(ctx, ref, status, since, limitPerStatus + 1, opts)
		)
	);
	return {
		rows: found
			.flatMap((rows) => rows.slice(0, limitPerStatus))
			.sort((a, b) => b.updatedAt - a.updatedAt),
		isCut: found.some((rows) => rows.length > limitPerStatus),
	};
}
