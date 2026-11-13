/**
 * The Team Inbox share of the Answer badge, counted from the threads instead
 * of the messages.
 *
 * The review queue (`clarificationHold.readPendingReview`) is the
 * `draft_ready` messages and the `awaiting_clarification` messages on open
 * conversations. Reading those rows to print a number reads their bodies and
 * drafts (an inline body may be 256 KiB) and joins each held one to its
 * thread, and every draft edit re-runs the badge in every admin's shell. Each
 * thread instead carries how many of its messages sit in either state
 * (`reviewDraftCount`, `reviewHeldCount`); the badge sums the threads that
 * have any, held ones only on an open or waiting thread, which is the same
 * "conversation still open" rule the list applies.
 *
 * Writers: the status transition is the only place a message's
 * `processingStatus` changes (`processingLifecycle/effects.ts`), and contact
 * erasure deletes messages from threads that stay (`contacts/erasure`). Both
 * move the counts by one. The drift sampler recounts a thread from its
 * messages (`maintenance/derivedFields`, id `teamReviewQueue`).
 *
 * Until migration 0074 has counted the existing messages, the counts are
 * incomplete and the badge reads the queue the old way.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { readMigrationRun } from '../lib/migrationLedger';
import { recountWithin, type RecountBudget } from '../maintenance/derivedFields/types';
import { readPendingReview } from './clarificationHold';

export const REVIEW_QUEUE_MIGRATION = '0074_backfill_review_queue_counts';

type CountField = 'reviewDraftCount' | 'reviewHeldCount';
type InboundStatus = Doc<'inboundMessages'>['processingStatus'];

const FIELD_OF: Partial<Record<InboundStatus, CountField>> = {
	draft_ready: 'reviewDraftCount',
	awaiting_clarification: 'reviewHeldCount',
};

/** Statuses a held question still needs an answer on. */
const OPEN_THREAD_STATUSES = ['open', 'waiting'] as const;

/**
 * Move `threadId`'s counts for one message going from `from` to `to`; `to`
 * null is the message being deleted. Zero is stored as absent, so a thread
 * with nothing queued drops out of the badge's index ranges.
 */
export async function moveReviewQueueCount(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'> | undefined,
	from: InboundStatus,
	to: InboundStatus | null
): Promise<void> {
	const left = FIELD_OF[from];
	const entered = to === null ? undefined : FIELD_OF[to];
	if (!threadId || left === entered) return;
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const patch: Partial<Record<CountField, number | undefined>> = {};
	if (left) patch[left] = Math.max(0, (thread[left] ?? 0) - 1) || undefined;
	if (entered) patch[entered] = (thread[entered] ?? 0) + 1;
	await ctx.db.patch(threadId, patch);
}

/** A thread's counts from its messages, as stored (zero absent); null past `budget`. */
export async function recountReviewQueue(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'conversationThreads'>,
	budget: RecountBudget
): Promise<Record<CountField, number | undefined> | null> {
	const counts: Record<CountField, number | undefined> = {
		reviewDraftCount: undefined,
		reviewHeldCount: undefined,
	};
	for (const [status, field] of Object.entries(FIELD_OF) as Array<[InboundStatus, CountField]>) {
		let n = 0;
		const isComplete = await recountWithin(
			ctx.db
				.query('inboundMessages')
				.withIndex('by_thread_and_processing_status', (q) =>
					q.eq('threadId', threadId).eq('processingStatus', status)
				),
			budget,
			() => {
				n += 1;
			}
		);
		if (!isComplete) return null;
		counts[field] = n || undefined;
	}
	return counts;
}

/** Add `field` over `threads` until `limit`; true once it is reached. */
async function addUpTo(
	threads: AsyncIterable<Doc<'conversationThreads'>>,
	field: CountField,
	total: { n: number },
	limit: number
): Promise<boolean> {
	for await (const thread of threads) {
		total.n += thread[field] ?? 0;
		if (total.n >= limit) return true;
	}
	return false;
}

/**
 * How many rows `readPendingReview(ctx, limit)` returns. Reads one thread per
 * thread with something queued, up to `limit` threads per range, plus the
 * queued messages that have no thread at all (rows from before every message
 * was threaded), which only the message index can find.
 */
export async function countPendingReview(ctx: QueryCtx, limit: number): Promise<number> {
	const run = await readMigrationRun(ctx, REVIEW_QUEUE_MIGRATION);
	if (run?.status !== 'completed') return (await readPendingReview(ctx, limit)).length;

	const total = { n: 0 };
	const withDrafts = ctx.db
		.query('conversationThreads')
		.withIndex('by_review_draft_count', (q) => q.gt('reviewDraftCount', 0));
	if (await addUpTo(withDrafts, 'reviewDraftCount', total, limit)) return limit;
	for (const status of OPEN_THREAD_STATUSES) {
		const withHeld = ctx.db
			.query('conversationThreads')
			.withIndex('by_status_and_review_held_count', (q) =>
				q.eq('status', status).gt('reviewHeldCount', 0)
			);
		if (await addUpTo(withHeld, 'reviewHeldCount', total, limit)) return limit;
	}
	for (const status of Object.keys(FIELD_OF) as InboundStatus[]) {
		const unthreaded = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread_and_processing_status', (q) =>
				q.eq('threadId', undefined).eq('processingStatus', status)
			)
			.take(limit - total.n);
		total.n += unthreaded.length;
		if (total.n >= limit) return limit;
	}
	return total.n;
}
