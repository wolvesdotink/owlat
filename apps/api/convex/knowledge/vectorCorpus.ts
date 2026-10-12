/**
 * Could a vector search find anything? (ADR-0073, Phase 1c empty-corpus skip.)
 *
 * Read by `embedRetrievalQuery` (`knowledge/vectorSearch.ts`) before it pays for a
 * query embedding: a search over a table with no queryable vector runs its
 * full-text leg alone, which is what a vector leg over an empty index came to.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { readSearchableSpace } from '../lib/aiRouting/embeddingRegistry';

export type VectorTable = 'knowledgeEntries' | 'semanticFiles';

const vectorTableValidator = v.union(v.literal('knowledgeEntries'), v.literal('semanticFiles'));

/**
 * Could a vector search over `table` return a row? A few indexed reads, never a
 * scan, so a corpus of vectorless rows (pending files, manual and curated
 * entries the extractor never embedded) answers "no".
 *
 * Retrieval searches only the active space, in its own column
 * (`knowledge/vectorSearch.ts`), so only that column counts:
 *   - no active space, or an active space the configuration no longer names
 *     (a switch whose first vector has not landed): a query embedded now would
 *     be in another space and could match nothing;
 *   - otherwise one `first()` on the active space's column: a primary vector is
 *     stamped with `embeddingGeneratedAt`, a secondary one is written only with
 *     its vector.
 * Rows without a space (written before provenance) are not searchable by vector
 * and do not count.
 */
async function tableHasVectors(ctx: QueryCtx, table: VectorTable): Promise<boolean> {
	const active = await readSearchableSpace(ctx.db);
	if (!active) return false;
	const row =
		active.slot === 'primary'
			? await ctx.db
					.query(table)
					.withIndex('by_embedding_space', (q) =>
						q.eq('embeddingSpaceId', active._id).gt('embeddingGeneratedAt', 0)
					)
					.first()
			: await ctx.db
					.query(table)
					.withIndex('by_secondary_embedding_space', (q) =>
						q.eq('secondaryEmbeddingSpaceId', active._id)
					)
					.first();
	return row !== null;
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
