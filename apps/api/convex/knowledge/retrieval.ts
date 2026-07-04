/**
 * Knowledge Graph — semantic retrieval.
 *
 * Vector search lives on the action context (`ctx.vectorSearch`), so the
 * real retrieval seam is an action: embed the query (when an explicit
 * embedding isn't supplied), run two legs — vector + full-text — and fuse them
 * with Reciprocal Rank Fusion, then hydrate the survivors to full documents.
 *
 * Hybrid (vector + FTS): pure vector recall blurs exact tokens an email/CRM
 * draft must ground on — an order number, a SKU, a surname, an unsubscribe
 * keyword. The FTS leg (`search_knowledge`) catches those; RRF merges the two
 * rankings scale-agnostically (no cosine-vs-BM25 normalization) and degrades to
 * vector-only when there's no query text or the FTS leg fails.
 *
 * Callers: the agent context-retrieval step (Step 1) and the `recallKnowledge`
 * agent tool (draft step). See ADR-0014 and the Knowledge Graph vision doc.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { embed } from 'ai';
import { getEmbeddingModel } from '../lib/llmProvider';
import { entryTypeValidator } from '../schema/knowledge';
import { logInfo } from '../lib/runtimeLog';
import { isContactScopeVisible } from '../lib/contactScope';
import { reciprocalRankFusion } from '../lib/rrf';
import { applyAuthorityPrecedence } from '../lib/knowledgePrecedence';
import {
	rankWithGraph,
	type GraphRankEdge,
	type GraphRankNeighbor,
	type RelationType,
} from '../lib/graphRank';

/**
 * One typed relationship a result entry participates in, for rendering the
 * connected subgraph. `direction` is relative to THIS entry: `outgoing` ⇒ this
 * entry is the edge's `from` ("this RELATION otherTitle"); `incoming` ⇒ this
 * entry is the `to`. `otherTitle` is UNTRUSTED (a neighbour's title) — callers
 * that feed it to a model must scrub it.
 */
export interface KnowledgeVia {
	relation: RelationType;
	otherTitle: string;
	direction: 'outgoing' | 'incoming';
}

/**
 * A knowledge entry annotated with its vector-search similarity score, plus the
 * optional graph-augmented annotations (`expandGraph` path only — absent on the
 * flat path, so existing callers are unaffected):
 *   - `_via`    — typed relationships connecting it within the returned subgraph.
 *   - `_caveat` — an endpoint of a `contradicts` edge (kept, but flag it).
 *   - `_stale`  — the target of a `supersedes` edge (a newer fact supersedes it).
 */
export type ScoredKnowledgeEntry = Doc<'knowledgeEntries'> & {
	_score: number;
	_via?: KnowledgeVia[];
	_caveat?: boolean;
	_stale?: boolean;
};

/**
 * Semantic search over knowledge entries (hybrid vector + full-text).
 *
 * Provide either `queryText` (embedded here, and used as-is for the FTS leg) or
 * a pre-computed `embedding` (vector leg only — no FTS without query text).
 * Returns full entry documents in fused relevance order, each annotated with its
 * vector similarity `_score` (0 for a hit that only matched full-text).
 *
 * Contact scoping (`scopeToContact`, REQUIRED) — the data-isolation gate for the
 * agent draft pipeline. Neither index can filter on `contactIds` (Convex can't
 * index array fields), so we over-fetch a candidate pool and post-filter by
 * contact membership AFTER fusion. The arg is required so retrieval is always an
 * explicit decision — a forgotten arg can't silently read org-wide:
 *   - 'org-wide'         → no scoping (the trusted-member assistant path, which
 *                          is allowed to see all). Explicit opt-in.
 *   - <contactId>        → keep entries that are org-general (no `contactIds`)
 *                          OR explicitly linked to that contact. A reply drafted
 *                          for contact A must never quote contact B's facts.
 *   - 'org-general-only' → keep only org-general entries (used when the inbound
 *                          message has no resolved contact, so we can't scope to
 *                          one — fail closed rather than leak everything).
 */
export const semanticSearch = internalAction({
	args: {
		queryText: v.optional(v.string()),
		embedding: v.optional(v.array(v.float64())),
		entryType: v.optional(entryTypeValidator),
		limit: v.optional(v.number()),
		// Required: 'org-wide' is the explicit member-path opt-out; any
		// contact-scoped caller passes a contactId or 'org-general-only'.
		scopeToContact: v.union(v.id('contacts'), v.literal('org-general-only'), v.literal('org-wide')),
		// Graph-augmented retrieval (seed-then-expand). Default/omitted ⇒ today's
		// flat behaviour. When true, the top visible seeds are expanded along the
		// knowledge-graph edges (per-hop scope-re-checked in graphTraversal.ts),
		// re-ranked, and annotated with _via/_caveat/_stale. Gated by
		// `ai.knowledge.graphRetrieval` at the CALL SITES — off ⇒ never passed true.
		expandGraph: v.optional(v.boolean()),
		hops: v.optional(v.number()),
		neighborBudget: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<ScoredKnowledgeEntry[]> => {
		const queryText = args.queryText?.trim();

		let vector = args.embedding;
		if (!vector || vector.length === 0) {
			if (!queryText) return [];
			try {
				const { embedding } = await embed({ model: getEmbeddingModel(), value: queryText });
				vector = Array.from(embedding);
			} catch (error) {
				logInfo('[knowledge.retrieval] embed failed', { error: String(error) });
				return [];
			}
		}

		const limit = args.limit ?? 10;
		const entryType = args.entryType;
		const scope = args.scopeToContact;
		// Over-fetch both legs so (a) the post-fusion contact filter still has
		// enough survivors to return `limit`, and (b) RRF ranks over a real
		// candidate pool, not an already-thinned one. Convex caps vectorSearch at
		// 256. The final slice keeps the returned count at `limit` regardless.
		const fetchLimit = Math.min(256, Math.max(limit * 5, 50));

		// Leg 1 — semantic vector search (paraphrase / conceptual matches).
		const hits = await ctx.vectorSearch('knowledgeEntries', 'vector_knowledge', {
			vector,
			limit: fetchLimit,
			filter: entryType ? (q) => q.eq('entryType', entryType) : undefined,
		});
		const vectorRanked: Id<'knowledgeEntries'>[] = hits.map((h) => h._id);
		const scoreById = new Map<string, number>(hits.map((h) => [h._id as string, h._score]));

		// Leg 2 — full-text search (exact tokens the embedding blurs). Only when we
		// have query text; fails soft to vector-only on any error.
		let ftsRanked: Id<'knowledgeEntries'>[] = [];
		if (queryText) {
			try {
				ftsRanked = await ctx.runQuery(internal.knowledge.graph.ftsRankedIds, {
					queryText,
					entryType,
					limit: fetchLimit,
				});
			} catch (error) {
				logInfo('[knowledge.retrieval] fts leg failed', { error: String(error) });
			}
		}

		// Fuse the two rankings (scale-agnostic; vector-only when FTS is empty).
		const fusedIds = reciprocalRankFusion<Id<'knowledgeEntries'>>([vectorRanked, ftsRanked]);
		if (fusedIds.length === 0) return [];

		// Hydrate in fused order (getByIds preserves input order, drops deleted).
		const entries = await ctx.runQuery(internal.knowledge.graph.getByIds, { ids: fusedIds });

		// Honor TTL at read time: expired entries are hard-deleted only lazily by
		// the decay cron, but the vector/FTS indexes still hold them until then, so
		// a reader must filter or it can quote a fact past its expiry.
		const now = Date.now();
		const live = entries.filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now);

		// `_score` stays the cosine similarity (0 for an FTS-only hit) so the
		// org-wide Q&A path can still interleave knowledge with file results on one
		// scale; RRF governs ORDER, which is what the draft path consumes.
		const scored = live.map((entry) => ({
			...entry,
			_score: scoreById.get(entry._id as string) ?? 0,
		}));

		// Contact scoping AFTER fusion (over-fetched above so this doesn't starve
		// the result set).
		const visible =
			scope === 'org-wide'
				? scored
				: scored.filter((entry) => isContactScopeVisible(entry.contactIds, scope));

		// Graph-augmented retrieval (seed-then-expand). KILL SWITCH: when
		// `expandGraph` is not set we take exactly the flat path below — byte for
		// byte the pre-existing behaviour. Wrapped in try/catch so any traversal
		// failure FAILS SOFT to the flat result rather than dropping retrieval.
		let returned: ScoredKnowledgeEntry[];
		if (args.expandGraph && visible.length > 0) {
			try {
				returned = await expandAndRank(ctx, {
					visible,
					vectorRanked,
					ftsRanked,
					scope,
					entryType,
					limit,
					hops: args.hops,
					neighborBudget: args.neighborBudget,
				});
			} catch (error) {
				logInfo('[knowledge.retrieval] graph expansion failed; falling back to flat', {
					error: String(error),
				});
				// Curated canonical answers still outrank scraped facts on the
				// fallback path; nothing here is `_stale`, so no supersede to honour.
				returned = applyAuthorityPrecedence(visible).slice(0, limit);
			}
		} else {
			// Flat path: promote curated canonical answers ahead of scraped facts
			// BEFORE the limit slice, so a policy never drops out of the top `limit`
			// just because a noisier fact fused higher.
			returned = applyAuthorityPrecedence(visible).slice(0, limit);
		}

		// Record the recall hit fire-and-forget (off the request critical path) so
		// the decay cron can keep frequently-grounded facts surfaced and let cold
		// ones fade faster.
		if (returned.length > 0) {
			await ctx.scheduler.runAfter(0, internal.knowledge.graph.recordAccess, {
				ids: returned.map((entry) => entry._id),
			});
		}
		return returned;
	},
});

/** Default 1-hop expansion with a modest neighbour budget. */
const DEFAULT_HOPS = 1;
const DEFAULT_NEIGHBOR_BUDGET = 16;
/** How many top visible entries seed the expansion (the rest still rank). */
const SEED_LIMIT = 12;
/** Cap on the typed relationships annotated onto a single result entry. */
const MAX_VIA = 6;

/**
 * Graph-augmented retrieval body: expand the top seeds along the knowledge-graph
 * edges, fuse + re-rank via `lib/graphRank.ts`, hydrate the union in ranked
 * order, and attach `_via`/`_caveat`/`_stale`. Kept here (not inlined) so the
 * action handler reads as "flat path OR this".
 *
 * SECURITY: `expandNeighbors` applies the per-hop scope gate to every neighbour,
 * so the neighbour ids are already visible. The seed legs are filtered to the
 * post-fusion `visible` pool BEFORE ranking — the raw vector/FTS legs still hold
 * the contact-B ids the scope filter dropped, and feeding those to the ranker
 * would re-surface them. As a result `orderedIds ⊆ visible ∪ visible-neighbours`,
 * and `getByIds` is only ever asked for already-checked ids (re-gated here too).
 */
async function expandAndRank(
	ctx: ActionCtx,
	params: {
		visible: ScoredKnowledgeEntry[];
		vectorRanked: Id<'knowledgeEntries'>[];
		ftsRanked: Id<'knowledgeEntries'>[];
		scope: Id<'contacts'> | 'org-general-only' | 'org-wide';
		entryType: Doc<'knowledgeEntries'>['entryType'] | undefined;
		limit: number;
		hops: number | undefined;
		neighborBudget: number | undefined;
	}
): Promise<ScoredKnowledgeEntry[]> {
	const { visible, vectorRanked, ftsRanked, scope, entryType, limit } = params;

	const seedIds = visible.slice(0, SEED_LIMIT).map((e) => e._id);

	const expansion = await ctx.runQuery(internal.knowledge.graphTraversal.expandNeighbors, {
		seedIds,
		scope,
		hops: params.hops ?? DEFAULT_HOPS,
		neighborBudget: params.neighborBudget ?? DEFAULT_NEIGHBOR_BUDGET,
		entryType,
	});

	// No connected subgraph reached ⇒ the graph path is exactly the flat slice.
	if (expansion.neighbors.length === 0 && expansion.edges.length === 0) {
		return visible.slice(0, limit);
	}

	// ★ Restrict the seed legs to the VISIBLE pool before ranking (see SECURITY). ★
	const visibleIdSet = new Set<string>(visible.map((e) => e._id as string));
	const vectorVisible = vectorRanked.filter((id) => visibleIdSet.has(id as string));
	const ftsVisible = ftsRanked.filter((id) => visibleIdSet.has(id as string));

	const neighbors: GraphRankNeighbor[] = expansion.neighbors.map((n) => ({
		id: n.id,
		hop: n.hop,
		relation: n.relation,
		seedProximity: 1 / (n.rootSeedIndex + 1),
		confidence: n.confidence,
	}));
	const edges: GraphRankEdge[] = expansion.edges.map((e) => ({
		fromId: e.fromId,
		toId: e.toId,
		relationType: e.relationType,
	}));

	const ranked = rankWithGraph({
		vectorRanked: vectorVisible,
		ftsRanked: ftsVisible,
		neighbors,
		edges,
	});

	// Hydrate neighbour docs (seeds are already hydrated in `visible`). Re-apply
	// the scope gate as defence in depth — getByIds itself does not scope.
	const neighborDocs = await ctx.runQuery(internal.knowledge.graph.getByIds, {
		ids: expansion.neighbors.map((n) => n.id),
	});
	const docById = new Map<string, ScoredKnowledgeEntry>();
	for (const s of visible) docById.set(s._id as string, s);
	for (const doc of neighborDocs) {
		const key = doc._id as string;
		if (docById.has(key)) continue;
		if (scope !== 'org-wide' && !isContactScopeVisible(doc.contactIds, scope)) continue;
		docById.set(key, { ...doc, _score: 0 });
	}

	// Titles for rendering `_via` (seeds + neighbours).
	const titleById = new Map<string, string>();
	for (const s of visible) titleById.set(s._id as string, s.title);
	for (const n of expansion.neighbors) titleById.set(n.id as string, n.title);

	const viaById = new Map<string, KnowledgeVia[]>();
	const pushVia = (id: string, via: KnowledgeVia): void => {
		const list = viaById.get(id) ?? [];
		if (list.length >= MAX_VIA) return;
		list.push(via);
		viaById.set(id, list);
	};
	for (const e of expansion.edges) {
		const from = e.fromId as string;
		const to = e.toId as string;
		const fromTitle = titleById.get(from);
		const toTitle = titleById.get(to);
		if (docById.has(from) && toTitle !== undefined) {
			pushVia(from, { relation: e.relationType, otherTitle: toTitle, direction: 'outgoing' });
		}
		if (docById.has(to) && fromTitle !== undefined) {
			pushVia(to, { relation: e.relationType, otherTitle: fromTitle, direction: 'incoming' });
		}
	}

	const supersededSet = new Set<string>(ranked.supersededIds.map((id) => id as string));
	const caveatSet = new Set<string>(ranked.caveatIds.map((id) => id as string));

	const out: ScoredKnowledgeEntry[] = [];
	for (const id of ranked.orderedIds) {
		const key = id as string;
		const doc = docById.get(key);
		if (!doc) continue;
		const annotated: ScoredKnowledgeEntry = { ...doc };
		const via = viaById.get(key);
		if (via && via.length > 0) annotated._via = via;
		if (caveatSet.has(key)) annotated._caveat = true;
		if (supersededSet.has(key)) annotated._stale = true;
		out.push(annotated);
	}
	// Promote curated canonical answers ahead of scraped facts, AFTER `_stale` is
	// attached above, so a policy superseded by a newer fact is NOT promoted (the
	// fresher fact still wins) — then take the top `limit`.
	return applyAuthorityPrecedence(out).slice(0, limit);
}
