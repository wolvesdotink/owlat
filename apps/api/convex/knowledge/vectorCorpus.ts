/**
 * Could a vector search find anything? (ADR-0073, Phase 1c empty-corpus skip.)
 *
 * Read by `embedRetrievalQuery` (`knowledge/retrieval.ts`) before it pays for a
 * query embedding: a search over a table with no queryable vector runs its
 * full-text leg alone, which is what a vector leg over an empty index came to.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../_generated/server';

export type VectorTable = 'knowledgeEntries' | 'semanticFiles';

const vectorTableValidator = v.union(v.literal('knowledgeEntries'), v.literal('semanticFiles'));

/**
 * Could a vector search over `table` return a row? Two indexed `first()` reads
 * at most, never a scan, so a corpus of vectorless rows (pending files, manual
 * and curated entries the extractor never embedded) answers "no".
 *
 * A row holds a vector exactly when `embeddingGeneratedAt` is set: every vector
 * writer has stamped it since the first release (knowledge/extraction.ts,
 * semanticFileProcessing.ts), and a placeholder `embedding: []` carries none.
 * So the ready rows are an index range on `by_embedding_space`:
 *   - rows with no embedding space yet (`embeddingSpaceId` absent), which is
 *     every row until the embed lane's provenance lands, and which today's
 *     unfiltered vector search reads;
 *   - rows in the active space (`embeddingSpaces`, `state: 'active'`), in
 *     either vector column.
 * Once retrieval filters to the active space, the first leg reads vectors
 * search no longer returns; it then errs towards one extra embedding, never
 * towards a skipped one, and the embed lane drops it with the filter.
 */
async function tableHasVectors(ctx: QueryCtx, table: VectorTable): Promise<boolean> {
	const unassigned = await ctx.db
		.query(table)
		.withIndex('by_embedding_space', (q) =>
			q.eq('embeddingSpaceId', undefined).gt('embeddingGeneratedAt', 0)
		)
		.first();
	if (unassigned) return true;
	const active = await ctx.db
		.query('embeddingSpaces')
		.withIndex('by_state', (q) => q.eq('state', 'active'))
		.first();
	if (!active) return false;
	const primary = await ctx.db
		.query(table)
		.withIndex('by_embedding_space', (q) =>
			q.eq('embeddingSpaceId', active._id).gt('embeddingGeneratedAt', 0)
		)
		.first();
	if (primary) return true;
	const secondary = await ctx.db
		.query(table)
		.withIndex('by_secondary_embedding_space', (q) => q.eq('secondaryEmbeddingSpaceId', active._id))
		.first();
	return secondary !== null;
}

/** True when a vector search over any of `tables` could return a row. */
export const hasQueryableVectors = internalQuery({
	args: { tables: v.array(vectorTableValidator) },
	handler: async (ctx, args): Promise<boolean> => {
		for (const table of new Set(args.tables)) {
			if (await tableHasVectors(ctx, table)) return true;
		}
		return false;
	},
});
