/**
 * The vector half of retrieval: the shared query embedding and the
 * space-filtered vector search behind both semantic searches
 * (`knowledge/retrieval.ts`, `semanticFileProcessing.ts`).
 *
 * A vector is compared only with vectors of its own space. The query embedding
 * learns its space (`measuredEmbeddingSpace`), and the vector leg filters each
 * index by that space's id, so legacy rows (no space) and rows of other spaces
 * never reach a vector leg; the full-text legs still find them.
 */

import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { meterLlmCall } from '../analytics/meteredSpend';
import { runEmbedding } from '../lib/llm/embed';
import type { LlmRootContext } from '../lib/llm/requestMeter';
import { resolveIndexEmbedder, toIndexVector } from '../lib/llmProvider';
import { measuredEmbeddingSpace, probeEmbeddingRevision } from '../lib/aiRouting/embeddingProbe';
import { embeddingSpaceEntryKey } from '../lib/aiRouting/embeddingKeys';
import { logInfo } from '../lib/runtimeLog';
import { secretFreeErrorText } from '../lib/embeddingSpace';
import type { VectorTable } from './vectorCorpus';
import { rethrowAdmissionRefusal } from '../lib/llm/admissionPort';

/**
 * The retrieval query embedding, made once and only when it can find something
 * (the empty-corpus skip).
 *
 * Knowledge search (below) and file search (`semanticFileProcessing.ts`) each
 * embedded the same query text, and Team retrieval called both, so one inbound
 * paid for two identical embeddings. And either embedded even when its table
 * held no vector at all, where the vector leg cannot return a row. Both now go
 * through this:
 *
 *   - it embeds only when a searched table holds a queryable vector
 *     (`knowledge/vectorCorpus.ts`); otherwise the caller runs the full-text
 *     leg alone;
 *   - Team retrieval embeds once for both tables and hands the same vector to
 *     both searches, with the query text still passed for both full-text legs.
 *
 * Failure semantics are the searches' own: a misconfigured embedder throws
 * (an actionable error, not silent emptiness), and an embed call that fails
 * makes the search return nothing.
 */
/**
 * The query vector for a search over `tables`:
 *   - `vector`: embedded once; use it for every table's vector leg, filtered to
 *     `embeddingSpaceId`, the active space the vector is in;
 *   - `no_vectors`: nothing to search by vector (no active space vectors, or
 *     the query landed in a space that is not active); run the full-text leg
 *     alone;
 *   - `failed`: the embedding call failed; the search returns nothing, as it
 *     did when each search embedded for itself.
 */
export type RetrievalQueryVector =
	| { kind: 'vector'; embedding: number[]; embeddingSpaceId: Id<'embeddingSpaces'> }
	| { kind: 'no_vectors' }
	| { kind: 'failed' };

export async function embedRetrievalQuery(
	ctx: ActionCtx,
	tables: readonly VectorTable[],
	queryText: string,
	logTag: string,
	/** The caller's root request: the query embedding's ledger row groups under it. */
	root?: LlmRootContext
): Promise<RetrievalQueryVector> {
	const hasVectors = await ctx.runQuery(internal.knowledge.vectorCorpus.hasQueryableVectors, {
		tables: [...tables],
	});
	if (!hasVectors) return { kind: 'no_vectors' };
	// Resolve OUTSIDE the try so a misconfigured embedder surfaces an actionable
	// error rather than silently returning zero results.
	const embedder = await resolveIndexEmbedder(ctx);
	let embedding: number[];
	let measured: Awaited<ReturnType<typeof measuredEmbeddingSpace>>;
	try {
		// The searches have always embedded the trimmed text; trimmed here once so
		// every caller's vector matches it.
		const before = await probeEmbeddingRevision(embedder.target);
		// One metered request per query: an embedding row in the ledger.
		const feature = tables.includes('knowledgeEntries')
			? 'embedding_knowledge_search'
			: 'embedding_file_search';
		const result = await meterLlmCall(
			ctx,
			{ feature, ...(root ? { root } : {}) },
			(meter) => runEmbedding({ meter, model: embedder.model, value: queryText.trim() }),
			// A lost ledger row under-counts; failing retrieval or indexing over it is worse.
			{ onWriteError: 'ignore' }
		);
		embedding = toIndexVector(result.embedding);
		measured = await measuredEmbeddingSpace(embedder.target, result.embedding, before);
	} catch (error) {
		// A budget refusal is the caller's to hold, defer or show (D1), not a failed embed.
		rethrowAdmissionRefusal(error);
		logInfo(`${logTag} embed failed`, { error: secretFreeErrorText(error) });
		return { kind: 'failed' };
	}
	// The vector is only comparable with its own space, and only an active space
	// is searched: a query in any other space has nothing to find.
	const target = await ctx.runQuery(internal.aiRouting.embeddingSpaces.searchTarget, {
		identity: measured,
	});
	if (!target) return { kind: 'no_vectors' };
	return { kind: 'vector', embedding, embeddingSpaceId: target.spaceId };
}

/** One vector hit: the row and its cosine similarity to the query. */
type VectorHit<T extends VectorTable> = { _id: Id<T>; _score: number };

/**
 * The vector leg of a search, filtered to ONE space: the space the query vector
 * is in. Every vector index is filtered by its column's space id, so a search
 * never compares vectors of two spaces, and unknown rows (no space)
 * are never returned. Without a space, or when that space is not active (staged
 * too, for the rebuild's validation), there is nothing to compare: no hits.
 *
 * The only `ctx.vectorSearch` calls in the backend (`check-contact-scope.sh`).
 * They return ids and scores; every caller applies its own contact scope.
 */
export async function searchSpaceVectors<T extends VectorTable>(
	ctx: ActionCtx,
	table: T,
	search: {
		vector: number[];
		embeddingSpaceId: Id<'embeddingSpaces'> | undefined;
		limit: number;
		entryType?: Doc<'knowledgeEntries'>['entryType'];
		allowStaged?: boolean;
	}
): Promise<VectorHit<T>[]> {
	if (!search.embeddingSpaceId) return [];
	const target = await ctx.runQuery(internal.aiRouting.embeddingSpaces.searchTarget, {
		spaceId: search.embeddingSpaceId,
		allowStaged: search.allowStaged,
	});
	if (!target) return [];
	const { spaceId, slot } = target;
	const { vector, limit, entryType } = search;
	if (table === 'semanticFiles') {
		const hits =
			slot === 'primary'
				? await ctx.vectorSearch('semanticFiles', 'vector_files', {
						vector,
						limit,
						filter: (q) => q.eq('embeddingSpaceId', spaceId),
					})
				: await ctx.vectorSearch('semanticFiles', 'vector_files_secondary', {
						vector,
						limit,
						filter: (q) => q.eq('secondaryEmbeddingSpaceId', spaceId),
					});
		return hits as VectorHit<T>[];
	}
	// Convex vector filters cannot AND: space-and-type is one composite key.
	const entryKey = entryType ? embeddingSpaceEntryKey(spaceId, entryType) : undefined;
	const hits =
		slot === 'primary'
			? await ctx.vectorSearch('knowledgeEntries', 'vector_knowledge', {
					vector,
					limit,
					filter: (q) =>
						entryKey ? q.eq('embeddingSpaceEntryKey', entryKey) : q.eq('embeddingSpaceId', spaceId),
				})
			: await ctx.vectorSearch('knowledgeEntries', 'vector_knowledge_secondary', {
					vector,
					limit,
					filter: (q) =>
						entryKey
							? q.eq('secondaryEmbeddingSpaceEntryKey', entryKey)
							: q.eq('secondaryEmbeddingSpaceId', spaceId),
				});
	return hits as VectorHit<T>[];
}
