/**
 * Thread brief erasure, the row level (SPEC §5 "Erasure"): the per-thread
 * readers of the seven tables and the one way to delete a row of them, shared
 * by every purge path:
 *
 *  - `purgeThread.ts` (a Postbox thread that lost its last message, an
 *    external account's teardown) drains them inline, then by a scheduled
 *    continuation;
 *  - the member and contact erasure walkers drain them within their budget
 *    (`auth/erasure/mailboxPhases.ts eraseThreads`,
 *    `contacts/erasure/contentPhases.ts eraseConversationThreads`);
 *  - `purge.ts` deletes single items and facts whose last evidence was a
 *    purged message.
 *
 * The note reactions in a thread's range are those on its Team Inbox notes
 * and Postbox discussion messages; the notes themselves are the team's and
 * are deleted (or kept) by their own owners.
 *
 * Deleting an item takes its links with it: the activity rows about it go,
 * and the commitment, team note and Postbox discussion message that point at
 * it lose the pointer (the rows are the user's or the team's and stay).
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ThreadBriefTable } from '../../schema/threadBrief';
import { threadRefFromFields, threadRefKey, type ThreadRef } from '../../lib/validators/threadRef';
import { loadBriefRow } from './briefRow';
import {
	completenessOfCounts,
	EMPTY_SOURCE_COUNTS,
	shiftCount,
	sourceBucketOf,
	type SourceBucket,
} from './counters';

/** Charges the documents a purge reads to a caller's budget (the erasure walkers). */
export type PurgeMeter = (doc: unknown) => void;

export const NO_METER: PurgeMeter = () => {};

/** Links read per deleted item and table. An item has a handful of each. */
const ITEM_LINK_LIMIT = 256;

type BriefRow = Doc<ThreadBriefTable>;

/** One bounded read of a per-thread range: up to `limit` rows. */
export type BriefRangeReader = (limit: number) => Promise<BriefRow[]>;

/**
 * The thread's rows of every thread brief table, children first (note
 * reactions, item corrections, plans, viewer state and activity before the
 * items and facts they point at; extractions and source snapshots; the brief
 * row, which holds the deletion epoch, last). Each reader returns the
 * first `limit` rows of its range; deleting a row takes it out of the range,
 * so draining a reader until it comes back short empties the table.
 */
export function threadBriefRanges(ctx: MutationCtx, ref: ThreadRef): BriefRangeReader[] {
	if (ref.kind === 'mail') {
		const id = ref.id;
		return [
			(n) =>
				ctx.db
					.query('noteReactions')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('threadItemCorrections')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('draftResponsePlans')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('threadViewerState')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('threadActivity')
					.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('threadFacts')
					.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('threadItems')
					.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('messageInterpretations')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('interpretSources')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.take(n),
			(n) =>
				ctx.db
					.query('threadBriefs')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', id))
					.take(n),
		];
	}
	const id = ref.id;
	return [
		(n) =>
			ctx.db
				.query('noteReactions')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', id))
				.take(n),
		(n) =>
			ctx.db
				.query('threadItemCorrections')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', id))
				.take(n),
		(n) =>
			ctx.db
				.query('draftResponsePlans')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', id))
				.take(n),
		(n) =>
			ctx.db
				.query('threadViewerState')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', id))
				.take(n),
		(n) =>
			ctx.db
				.query('threadActivity')
				.withIndex('by_conversation_thread_and_seq', (q) => q.eq('conversationThreadId', id))
				.take(n),
		// Facts are written for mail threads only (brief mode); the table has no team index.
		(n) =>
			ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread_and_status', (q) => q.eq('conversationThreadId', id))
				.take(n),
		(n) =>
			ctx.db
				.query('messageInterpretations')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', id))
				.take(n),
		(n) =>
			ctx.db
				.query('interpretSources')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', id))
				.take(n),
		(n) =>
			ctx.db
				.query('threadBriefs')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', id))
				.take(n),
	];
}

/**
 * Bump the thread's deletion epoch (and drop its overview cache) before its
 * rows go, so an interpretation that loaded the thread earlier gets `erased`
 * instead of writing derived content back. No-op without a brief row.
 */
export async function bumpDeletionEpoch(
	ctx: MutationCtx,
	ref: ThreadRef,
	meter: PurgeMeter = NO_METER
): Promise<Doc<'threadBriefs'> | null> {
	const brief = await loadBriefRow(ctx, ref);
	if (!brief) return null;
	meter(brief);
	await ctx.db.patch(brief._id, {
		deletionEpoch: brief.deletionEpoch + 1,
		overview: undefined,
		updatedAt: Date.now(),
	});
	return brief;
}

/**
 * Take a deleted item's links out of the rows outside the thread brief tables
 * (the commitment, team note and discussion message stay, without the
 * pointer) and delete the activity rows and corrections about it. Call before the item row
 * goes. Bounded per table by {@link ITEM_LINK_LIMIT}.
 */
export async function unlinkDeletedItem(
	ctx: MutationCtx,
	itemId: Id<'threadItems'>,
	meter: PurgeMeter = NO_METER
): Promise<void> {
	const activity = await ctx.db
		.query('threadActivity')
		.withIndex('by_item', (q) => q.eq('itemId', itemId))
		.take(ITEM_LINK_LIMIT);
	for (const row of activity) {
		meter(row);
		await ctx.db.delete(row._id);
	}
	const corrections = await ctx.db
		.query('threadItemCorrections')
		.withIndex('by_item', (q) => q.eq('itemId', itemId))
		.take(ITEM_LINK_LIMIT);
	for (const row of corrections) {
		meter(row);
		await ctx.db.delete(row._id);
	}
	const commitments = await ctx.db
		.query('mailCommitments')
		.withIndex('by_thread_item', (q) => q.eq('threadItemId', itemId))
		.take(ITEM_LINK_LIMIT);
	for (const row of commitments) {
		meter(row);
		await ctx.db.patch(row._id, { threadItemId: undefined });
	}
	const notes = await ctx.db
		.query('threadNotes')
		.withIndex('by_thread_item', (q) => q.eq('threadItemId', itemId))
		.take(ITEM_LINK_LIMIT);
	for (const row of notes) {
		meter(row);
		await ctx.db.patch(row._id, { threadItemId: undefined });
	}
	const messages = await ctx.db
		.query('chatMessages')
		.withIndex('by_thread_item', (q) => q.eq('threadItemId', itemId))
		.take(ITEM_LINK_LIMIT);
	for (const row of messages) {
		meter(row);
		await ctx.db.patch(row._id, { threadItemId: undefined });
	}
}

/** Delete one row read from {@link threadBriefRanges}; an item takes its links with it. */
export async function deleteThreadBriefRow(
	ctx: MutationCtx,
	row: BriefRow,
	meter: PurgeMeter = NO_METER
): Promise<void> {
	if (isItemRow(row)) await unlinkDeletedItem(ctx, row._id, meter);
	await ctx.db.delete(row._id);
}

/** A `threadItems` row: the only brief table with both evidence and a disposition. */
function isItemRow(row: BriefRow): row is Doc<'threadItems'> {
	return 'disposition' in row && 'evidence' in row;
}

/**
 * Delete extraction rows and take each CURRENT one out of its brief's source
 * counters (`counters.ts`), so completeness stays right without a scan.
 */
export async function deleteExtractions(
	ctx: MutationCtx,
	rows: readonly Doc<'messageInterpretations'>[],
	meter: PurgeMeter = NO_METER
): Promise<void> {
	const shifts = new Map<string, { ref: ThreadRef; buckets: SourceBucket[] }>();
	for (const row of rows) {
		meter(row);
		await ctx.db.delete(row._id);
		if (row.isCurrent !== true) continue;
		const ref = threadRefFromFields(row);
		const key = threadRefKey(ref);
		const entry = shifts.get(key) ?? { ref, buckets: [] };
		entry.buckets.push(sourceBucketOf(row));
		shifts.set(key, entry);
	}
	for (const { ref, buckets } of shifts.values()) {
		const brief = await loadBriefRow(ctx, ref);
		if (!brief) continue;
		let counts = brief.sourceCounts ?? EMPTY_SOURCE_COUNTS;
		for (const bucket of buckets) counts = shiftCount(counts, bucket, null);
		await ctx.db.patch(brief._id, { sourceCounts: counts });
	}
}

/**
 * The thread's completeness from its source counters, after a purge or a
 * scope change removed extractions. The one place either derives it.
 */
export async function recomputeCompleteness(
	ctx: MutationCtx,
	ref: ThreadRef
): Promise<Doc<'threadBriefs'>['completeness']> {
	const brief = await loadBriefRow(ctx, ref);
	return completenessOfCounts(brief?.sourceCounts ?? EMPTY_SOURCE_COUNTS);
}
