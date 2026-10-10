/**
 * Thread brief erasure, the row level (SPEC §5 "Erasure"): the per-thread
 * readers of the thread brief tables, the deletion epoch bump, the extraction
 * delete that keeps the source counters, and the completeness recompute. The
 * resumable walks over them are the purge jobs (`purgeDrain.ts`).
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ThreadBriefTable } from '../../schema/threadBrief';
import { threadRefFromFields, threadRefKey, type ThreadRef } from '../../lib/validators/threadRef';
import { loadBriefRow } from './briefRow';
import { briefCompleteness, isRepairMarked, shiftPendingRepairs } from './purgeRepairs';
import { EMPTY_SOURCE_COUNTS, shiftCount, sourceBucketOf, type SourceBucket } from './counters';

export type BriefRow = Doc<ThreadBriefTable>;

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
	ref: ThreadRef
): Promise<Doc<'threadBriefs'> | null> {
	const brief = await loadBriefRow(ctx, ref);
	if (!brief) return null;
	await ctx.db.patch(brief._id, {
		deletionEpoch: brief.deletionEpoch + 1,
		overview: undefined,
		updatedAt: Date.now(),
	});
	return brief;
}

/**
 * Delete extraction rows and take each COUNTED one (the newest attempt of its
 * source, `isCounted`) out of its brief's source counters (`counters.ts`), so
 * completeness stays right without a scan. A message purge deletes every row
 * of the source, so no current or counted mark is left to re-assign.
 */
export async function deleteExtractions(
	ctx: MutationCtx,
	rows: readonly Doc<'messageInterpretations'>[]
): Promise<void> {
	const shifts = new Map<string, { ref: ThreadRef; buckets: SourceBucket[] }>();
	for (const row of rows) {
		await ctx.db.delete(row._id);
		if (row.isCounted !== true) continue;
		// A marked row's outstanding repair goes with it (purgeRepairs.ts).
		if (isRepairMarked(row)) {
			const brief = await loadBriefRow(ctx, threadRefFromFields(row));
			if (brief) await shiftPendingRepairs(ctx, brief._id, -1);
		}
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
	return brief ? briefCompleteness(brief) : 'none';
}
