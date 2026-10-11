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
 * How many rows the existence check reads per table. A table holds a vector in
 * almost every row (a placeholder `embedding: []` lasts only until processing
 * fills it), so the oldest few settle it.
 */
const CORPUS_SAMPLE = 8;

/**
 * Could a vector search over `table` return a row? Bounded: it reads at most
 * {@link CORPUS_SAMPLE} rows. Errs towards "yes": an empty table is the only
 * certain "no" besides a short table whose every row is vectorless. A full
 * sample with no vector in it answers "yes", because a vector may sit further
 * on; the cost of that answer is one embedding, which is today's behaviour.
 *
 * Every row counts today, because vector search reads every row. The embed
 * lane's space filter narrows search to the active embedding space; this check
 * must narrow with it (`by_embedding_space` on the active space id), or it
 * would keep answering "yes" for vectors search can no longer return.
 */
async function tableHasVectors(ctx: QueryCtx, table: VectorTable): Promise<boolean> {
	const rows = await ctx.db.query(table).order('asc').take(CORPUS_SAMPLE);
	if (rows.length === 0) return false;
	if (rows.some((row) => row.embedding.length > 0)) return true;
	return rows.length === CORPUS_SAMPLE;
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
