/**
 * A source's knowledge extraction progress (ADR-0073, D1; Sol r2 F3).
 *
 * An extraction asks the model once, then saves the entries one by one,
 * embedding each first. A spend refusal (or a crash) between two entries
 * left the source with some entries and, before this marker, every later run
 * read "has entries" as "done", so the rest and the structural links were
 * never written.
 *
 * Now the persist step marks the source `in_progress` with the entries the
 * model returned before it saves the first one, and `complete` after the last
 * one is saved and the linker is scheduled. A run that finds `in_progress`
 * resumes from the stored entries without asking the model again: the ones
 * already saved are found by the dedupe before any embedding
 * (`knowledge/entryDedupe.ts`), so only the unfinished ones are embedded, and
 * the linker gets the whole set.
 *
 * Without a marker (sources from before it, or a complete one past its
 * retention) the old rule stands: a source with entries is done. An unfinished
 * marker is never aged out; it goes when its source is deleted.
 */

import { v } from 'convex/values';
import type { Infer } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { extractedEntryValidator } from '../schema/aiRouting';

const sourceTypeValidator = v.union(
	v.literal('agent_extracted'),
	v.literal('file'),
	v.literal('email')
);

const sourceArgs = { sourceType: sourceTypeValidator, sourceId: v.string() };

export type ExtractionSourceType = Infer<typeof sourceTypeValidator>;
type ExtractedEntryShape = Infer<typeof extractedEntryValidator>;

/** Whether the source is done, and the entries a resumed run saves when it is not. */
export const extractionProgressOf = internalQuery({
	args: sourceArgs,
	returns: v.object({
		isDone: v.boolean(),
		/** Started and not complete: a run resumes it (and a backfill counts it apart). */
		isPartial: v.boolean(),
		pendingEntries: v.optional(v.array(extractedEntryValidator)),
	}),
	handler: (ctx, args) => readExtractionProgress(ctx, args.sourceType, args.sourceId),
});

/** {@link extractionProgressOf}, for a query or mutation that already has `ctx.db`. */
export async function readExtractionProgress(
	ctx: QueryCtx,
	sourceType: ExtractionSourceType,
	sourceId: string
): Promise<{ isDone: boolean; isPartial: boolean; pendingEntries?: ExtractedEntryShape[] }> {
	const marker = await ctx.db
		.query('knowledgeExtractionProgress')
		.withIndex('by_source', (q) => q.eq('sourceType', sourceType).eq('sourceId', sourceId))
		.first();
	if (marker) {
		if (marker.status === 'complete') return { isDone: true, isPartial: false };
		return {
			isDone: false,
			isPartial: true,
			...(marker.entries ? { pendingEntries: marker.entries } : {}),
		};
	}
	const entry = await ctx.db
		.query('knowledgeEntries')
		.withIndex('by_source', (q) => q.eq('sourceType', sourceType).eq('sourceId', sourceId))
		.first();
	return { isDone: entry !== null, isPartial: false };
}

/** `in_progress` carries the entries to save; `complete` drops them. */
export const markExtraction = internalMutation({
	args: {
		...sourceArgs,
		status: v.union(v.literal('in_progress'), v.literal('complete')),
		entries: v.optional(v.array(extractedEntryValidator)),
	},
	handler: (ctx, args) =>
		writeExtractionMarker(ctx, args.sourceType, args.sourceId, args.status, args.entries),
});

/**
 * {@link markExtraction}, in the caller's mutation: a provider batch item's
 * result (`aiRouting/batchItems.ts`, L14) becomes the `in_progress` marker a
 * resumed extraction saves, in the transaction that closes the item.
 */
export async function writeExtractionMarker(
	ctx: MutationCtx,
	sourceType: ExtractionSourceType,
	sourceId: string,
	status: 'in_progress' | 'complete',
	entries?: ExtractedEntryShape[]
): Promise<void> {
	const fields = {
		status,
		entries: status === 'in_progress' ? entries : undefined,
		updatedAt: Date.now(),
	};
	const marker = await ctx.db
		.query('knowledgeExtractionProgress')
		.withIndex('by_source', (q) => q.eq('sourceType', sourceType).eq('sourceId', sourceId))
		.first();
	if (marker) await ctx.db.patch(marker._id, fields);
	else await ctx.db.insert('knowledgeExtractionProgress', { sourceType, sourceId, ...fields });
}

/**
 * A source was deleted: its marker goes with it, unfinished or not (Sol r3 F2).
 * Retention never removes an unfinished marker, so the deleting paths do.
 */
export async function dropExtractionProgress(
	ctx: MutationCtx,
	sourceType: ExtractionSourceType,
	sourceId: string
): Promise<void> {
	const markers = await ctx.db
		.query('knowledgeExtractionProgress')
		.withIndex('by_source', (q) => q.eq('sourceType', sourceType).eq('sourceId', sourceId))
		.take(10);
	for (const marker of markers) await ctx.db.delete(marker._id);
}
