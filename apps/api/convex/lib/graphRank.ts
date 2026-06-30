/**
 * Graph-augmented ranking — pure, ctx-free fusion + rerank for seed-then-expand
 * retrieval.
 *
 * The knowledge layer is a typed graph (knowledgeEntries nodes joined by
 * knowledgeRelations edges). `knowledge/retrieval.ts` seeds a candidate set with
 * the existing hybrid vector+FTS search, expands one to two hops along the edges
 * (`knowledge/graphTraversal.ts`, which enforces the per-hop contact-scope gate),
 * then calls this module to fuse the three rankings (vector / FTS / neighbour)
 * into one connected, deterministically re-ranked subgraph.
 *
 * Everything here is pure and dependency-free apart from the shared
 * {@link reciprocalRankFusion} (so there is one fusion in the codebase, not two)
 * and the schema's relation-type tuple. No Convex `ctx`, no I/O, no contact-scope
 * logic — by the time ids reach this module the traversal seam has already
 * dropped every node a caller may not see, so ranking can be a plain function of
 * id lists + edge metadata and unit-tests in isolation.
 *
 * SECURITY NOTE: this module performs NO scope filtering. It must only ever be
 * fed ids the caller has already proven visible — the seed legs filtered to the
 * post-fusion visible pool, and neighbours emitted by `expandNeighbors` (which
 * re-checks `isContactScopeVisible` per hop). Feeding it raw, unfiltered seed
 * legs would surface every id they contain — see the comment at its call site.
 */

import type { Id } from '../_generated/dataModel';
import { RELATION_TYPES } from '../schema/knowledge';
import { reciprocalRankFusion } from './rrf';

/** A typed knowledge-graph edge kind. Derived from the schema's single source. */
export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * How much an edge of each kind contributes to a neighbour's graph rank. A
 * `supersedes` edge is the strongest signal (the newer fact is the one to
 * surface), `contradicts` the weakest (we keep both endpoints but flag them as a
 * caveat rather than promote them). Used as the `weight` factor of the neighbour
 * score below. Every relation type has an entry so a lookup is never undefined.
 */
export const RELATION_WEIGHTS: Record<RelationType, number> = {
	supersedes: 1.0,
	supports: 0.8,
	causes: 0.7,
	blocks: 0.6,
	relates_to: 0.5,
	contradicts: 0.4,
};

/**
 * A neighbour discovered by the graph traversal, with the signals needed to rank
 * it. `relation` is the strongest edge that reached it (its weight comes from
 * {@link RELATION_WEIGHTS}); `seedProximity` is `1/(rootSeedRank+1)` of the seed
 * its BFS branch started from (closer to a top seed ⇒ higher); `confidence` is
 * the reaching edge's 0-1 confidence; `hop` is 1 or 2.
 */
export interface GraphRankNeighbor {
	id: Id<'knowledgeEntries'>;
	hop: number;
	relation: RelationType;
	seedProximity: number;
	confidence: number;
}

/** A directed edge among the visible subgraph, used for supersedes/contradicts. */
export interface GraphRankEdge {
	fromId: Id<'knowledgeEntries'>;
	toId: Id<'knowledgeEntries'>;
	relationType: RelationType;
}

export interface RankWithGraphInput {
	/** Vector-leg ranking, filtered to the visible pool. */
	vectorRanked: readonly Id<'knowledgeEntries'>[];
	/** FTS-leg ranking, filtered to the visible pool. */
	ftsRanked: readonly Id<'knowledgeEntries'>[];
	/** Visible neighbours emitted by the per-hop-scoped traversal. */
	neighbors: readonly GraphRankNeighbor[];
	/** Edges among the visible subgraph (both endpoints visible). */
	edges: readonly GraphRankEdge[];
}

export interface RankWithGraphResult {
	/** The fused, deterministically re-ranked id list (seeds + neighbours). */
	orderedIds: Id<'knowledgeEntries'>[];
	/** Endpoints of a `contradicts` edge — KEPT, but flagged as a caveat. */
	caveatIds: Id<'knowledgeEntries'>[];
	/** Targets of a `supersedes` edge — demoted to the bottom + flagged stale. */
	supersededIds: Id<'knowledgeEntries'>[];
}

function clamp01(n: number): number {
	if (Number.isNaN(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

/**
 * Fuse the vector, FTS, and graph-neighbour rankings into one connected subgraph
 * ordering, then deterministically re-rank.
 *
 * Steps:
 *   1. Score each neighbour `weight × 1/hop × seedProximity × confidence` and
 *      sort into a neighbour ranking (a third RRF leg).
 *   2. Fuse the three rankings via the shared {@link reciprocalRankFusion}.
 *   3. Re-rank with two deterministic keys layered over the fused order:
 *        - `supersedes` TARGETS sink to the bottom (and are reported in
 *          `supersededIds` so the caller can mark them stale / "do not rely"),
 *        - a single-edge pure neighbour can never outrank a SEED (a fact two
 *          independent retrieval legs agreed on, or any direct hit) — it is
 *          placed in a lower band; multi-edge neighbours (reached by ≥2 edges)
 *          may interleave with seeds on fused score.
 *      `contradicts` endpoints are flagged in `caveatIds` but NOT moved — the
 *      caller surfaces both sides framed as a caveat.
 *
 * Invariant: with no neighbours (and no supersedes), the output is byte-identical
 * to plain `reciprocalRankFusion([vectorRanked, ftsRanked])` — the kill switch in
 * `knowledge/retrieval.ts` relies on this so `expandGraph:false` is a true no-op.
 */
export function rankWithGraph(input: RankWithGraphInput): RankWithGraphResult {
	const { vectorRanked, ftsRanked, neighbors, edges } = input;

	// (1) Neighbour ranking: weight × 1/hop × seed-proximity × confidence.
	// A neighbour reached by several edges keeps its strongest (max) score.
	const neighborScore = new Map<Id<'knowledgeEntries'>, number>();
	for (const n of neighbors) {
		const weight = RELATION_WEIGHTS[n.relation] ?? RELATION_WEIGHTS.relates_to;
		const hop = Math.max(1, n.hop);
		const score = weight * (1 / hop) * clamp01(n.seedProximity) * clamp01(n.confidence);
		neighborScore.set(n.id, Math.max(neighborScore.get(n.id) ?? 0, score));
	}
	const neighborRanked = [...neighborScore.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([id]) => id);

	// (2) Fuse the three legs (reuse the one shared RRF). An empty leg adds
	// nothing, so with no neighbours this equals RRF([vector, fts]).
	const fused = reciprocalRankFusion<Id<'knowledgeEntries'>>([
		vectorRanked,
		ftsRanked,
		neighborRanked,
	]);
	const fusedIndex = new Map<Id<'knowledgeEntries'>, number>(fused.map((id, i) => [id, i]));

	// Seeds = anything a retrieval leg returned. Edge degree over the visible
	// subgraph distinguishes a single-edge pure neighbour from a hub.
	const seedSet = new Set<Id<'knowledgeEntries'>>([...vectorRanked, ...ftsRanked]);
	const degree = new Map<Id<'knowledgeEntries'>, number>();
	for (const e of edges) {
		degree.set(e.fromId, (degree.get(e.fromId) ?? 0) + 1);
		degree.set(e.toId, (degree.get(e.toId) ?? 0) + 1);
	}

	// supersedes A→B ⇒ B (the target) is stale: demote + flag. contradicts X↔Y ⇒
	// both endpoints kept but flagged. Only ids actually in the candidate set.
	const supersededSet = new Set<Id<'knowledgeEntries'>>();
	const caveatSet = new Set<Id<'knowledgeEntries'>>();
	for (const e of edges) {
		if (e.relationType === 'supersedes' && fusedIndex.has(e.toId)) {
			supersededSet.add(e.toId);
		} else if (e.relationType === 'contradicts') {
			if (fusedIndex.has(e.fromId)) caveatSet.add(e.fromId);
			if (fusedIndex.has(e.toId)) caveatSet.add(e.toId);
		}
	}

	// A single-edge pure neighbour sits below every seed (incl. both-legs seeds);
	// seeds and multi-edge neighbours stay in band 0. This is a no-op when there
	// are no pure neighbours, preserving the kill-switch invariant.
	const band = (id: Id<'knowledgeEntries'>): number => {
		if (seedSet.has(id)) return 0;
		return (degree.get(id) ?? 0) <= 1 ? 1 : 0;
	};

	const orderedIds = [...fused].sort((a, b) => {
		const stale = (supersededSet.has(a) ? 1 : 0) - (supersededSet.has(b) ? 1 : 0);
		if (stale !== 0) return stale; // superseded → bottom
		const bandDelta = band(a) - band(b);
		if (bandDelta !== 0) return bandDelta; // single-edge neighbour → below seeds
		return fusedIndex.get(a)! - fusedIndex.get(b)!; // else keep fused order
	});

	return {
		orderedIds,
		caveatIds: [...caveatSet],
		supersededIds: [...supersededSet],
	};
}
