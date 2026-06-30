/**
 * Knowledge-graph traversal — the seed-then-expand seam for graph-augmented
 * retrieval, and THE per-hop data-isolation gate (leak surface #1).
 *
 * `knowledge/retrieval.ts:semanticSearch` seeds a candidate set with the hybrid
 * vector+FTS search, then (when `expandGraph` is on) calls `expandNeighbors`
 * here to walk one to two hops along `knowledgeRelations` edges and pull in the
 * connected subgraph, which `lib/graphRank.ts` then re-ranks.
 *
 * ★ SECURITY — why this is its own reviewed seam ★
 * Edges have NO contact scope of their own, and a dedup-merge unions a node's
 * `contactIds`, so an edge can join a contact-A node to a contact-B-ONLY node.
 * Following an edge is therefore a privilege-escalation primitive. EVERY hydrated
 * neighbour is re-checked with `isContactScopeVisible(neighbour.contactIds,
 * scope)` before it can enter the result — 'org-wide' is the ONLY scope allowed
 * to skip it. A neighbour that fails the check is DROPPED: no neighbour row, and
 * crucially no edge to it is emitted (a dropped contact-B node leaks neither its
 * content nor its existence), and it never becomes a frontier (so a 2-hop walk
 * cannot reach ITS neighbours either — containment). This file is allowlisted in
 * `scripts/check-graph-scope.sh`, which positively asserts it calls
 * `isContactScopeVisible`.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { isContactScopeVisible } from '../lib/contactScope';
import { isFeatureEnabled } from '../lib/featureFlags';
import { RELATION_WEIGHTS, type RelationType } from '../lib/graphRank';
import { entryTypeValidator } from '../schema/knowledge';

/** A visible neighbour reached by the traversal, with ranking + render metadata. */
export interface ExpandedNeighbor {
	id: Id<'knowledgeEntries'>;
	title: string;
	entryType: Doc<'knowledgeEntries'>['entryType'];
	/** 1 or 2 — how many hops from a seed this neighbour was reached. */
	hop: number;
	/** Index in the input `seedIds` of the seed whose BFS branch reached it. */
	rootSeedIndex: number;
	/** Strongest (highest-weighted) edge kind that reached it. */
	relation: RelationType;
	/** Confidence (0-1) of that strongest reaching edge. */
	confidence: number;
}

/** A directed edge among the visible subgraph (both endpoints are visible). */
export interface ExpandedEdge {
	fromId: Id<'knowledgeEntries'>;
	toId: Id<'knowledgeEntries'>;
	relationType: RelationType;
	confidence: number;
}

export interface ExpandNeighborsResult {
	neighbors: ExpandedNeighbor[];
	edges: ExpandedEdge[];
}

/** Largest connected subgraph (edges) `expandNeighbors` will ever return. */
const MAX_EDGES = 512;

/**
 * Whether graph-augmented retrieval is enabled (`ai.knowledge.graphRetrieval`).
 * The kill switch: the agent context step and the assistant `searchKnowledge`
 * tool read this from their action context (via `ctx.runQuery`) and only pass
 * `expandGraph:true` when it is on, so off ⇒ byte-identical flat retrieval.
 */
export const isGraphRetrievalEnabled = internalQuery({
	args: {},
	handler: async (ctx): Promise<boolean> => isFeatureEnabled(ctx, 'ai.knowledge.graphRetrieval'),
});

/**
 * Expand a connected subgraph around the given seeds, re-checking contact scope
 * on every hop. Called from the retrieval action via `ctx.runQuery` (the edge
 * reads need a query context).
 *
 * The seeds are assumed already visible (the caller filtered the candidate pool
 * through `isContactScopeVisible` before choosing them). The gate here is for the
 * NEIGHBOURS edges reach. Pass `seedIds` ordered by importance — a neighbour's
 * `rootSeedIndex` is the index of the seed its BFS branch started from, which the
 * ranker turns into seed-proximity.
 */
export const expandNeighbors = internalQuery({
	args: {
		seedIds: v.array(v.id('knowledgeEntries')),
		// Same scope contract as semanticSearch: 'org-wide' is the only value that
		// skips the per-hop visibility re-check.
		scope: v.union(v.id('contacts'), v.literal('org-general-only'), v.literal('org-wide')),
		hops: v.number(),
		neighborBudget: v.number(),
		entryType: v.optional(entryTypeValidator),
		perNodeEdgeCap: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<ExpandNeighborsResult> => {
		const hops = Math.max(1, Math.min(2, Math.trunc(args.hops)));
		const neighborBudget = Math.max(1, Math.min(32, Math.trunc(args.neighborBudget)));
		const perNodeEdgeCap = Math.max(1, Math.min(64, Math.trunc(args.perNodeEdgeCap ?? 32)));
		const scope = args.scope;
		const entryType = args.entryType;
		const now = Date.now();

		// Seeds start the BFS at hop 0; they are already visible, so they never
		// re-enter the neighbour set — only edges to them are recorded.
		const visited = new Set<Id<'knowledgeEntries'>>(args.seedIds);
		const neighbors = new Map<Id<'knowledgeEntries'>, ExpandedNeighbor>();
		const edges: ExpandedEdge[] = [];
		const seenEdge = new Set<string>();

		let frontier: { id: Id<'knowledgeEntries'>; rootSeedIndex: number }[] = args.seedIds.map(
			(id, i) => ({ id, rootSeedIndex: i }),
		);

		for (let hop = 1; hop <= hops; hop++) {
			const nextFrontier: { id: Id<'knowledgeEntries'>; rootSeedIndex: number }[] = [];

			for (const node of frontier) {
				const outgoing = await ctx.db
					.query('knowledgeRelations')
					.withIndex('by_from', (q) => q.eq('fromEntryId', node.id))
					.take(perNodeEdgeCap);
				const incoming = await ctx.db
					.query('knowledgeRelations')
					.withIndex('by_to', (q) => q.eq('toEntryId', node.id))
					.take(perNodeEdgeCap);

				for (const edge of [...outgoing, ...incoming]) {
					if (edges.length >= MAX_EDGES) break;
					const neighborId =
						edge.fromEntryId === node.id ? edge.toEntryId : edge.fromEntryId;
					const relation = edge.relationType as RelationType;
					const edgeConfidence = edge.confidence;

					// Already-visible node (a seed or an earlier-accepted neighbour): the
					// edge connects two visible nodes, so record it (once) — but don't
					// re-add it as a neighbour/frontier.
					if (visited.has(neighborId)) {
						recordEdge(edges, seenEdge, edge._id, {
							fromId: edge.fromEntryId,
							toId: edge.toEntryId,
							relationType: relation,
							confidence: edgeConfidence,
						});
						bumpNeighborMeta(neighbors, neighborId, relation, edgeConfidence, node.rootSeedIndex);
						continue;
					}

					const entry = await ctx.db.get(neighborId);
					if (!entry) continue;

					// Gates, in order: TTL → entryType → ★ THE PER-HOP SCOPE GATE ★.
					if (entry.expiresAt !== undefined && entry.expiresAt <= now) continue;
					if (entryType && entry.entryType !== entryType) continue;
					const visible =
						scope === 'org-wide' ? true : isContactScopeVisible(entry.contactIds, scope);
					// A dropped node leaks neither content nor existence: no edge is
					// emitted and it never becomes a frontier (2-hop containment).
					if (!visible) continue;

					// Respect the neighbour budget — don't accept new nodes past it
					// (already-visible edges above are still recorded for ranking).
					if (neighbors.size >= neighborBudget) continue;

					neighbors.set(neighborId, {
						id: neighborId,
						title: entry.title,
						entryType: entry.entryType,
						hop,
						rootSeedIndex: node.rootSeedIndex,
						relation,
						confidence: edgeConfidence,
					});
					visited.add(neighborId);
					nextFrontier.push({ id: neighborId, rootSeedIndex: node.rootSeedIndex });
					recordEdge(edges, seenEdge, edge._id, {
						fromId: edge.fromEntryId,
						toId: edge.toEntryId,
						relationType: relation,
						confidence: edgeConfidence,
					});
				}
				if (edges.length >= MAX_EDGES) break;
			}

			frontier = nextFrontier;
			if (frontier.length === 0) break;
		}

		return { neighbors: [...neighbors.values()], edges };
	},
});

/** Record an edge once (dedup by row id). */
function recordEdge(
	edges: ExpandedEdge[],
	seen: Set<string>,
	rowId: Id<'knowledgeRelations'>,
	edge: ExpandedEdge,
): void {
	if (seen.has(rowId)) return;
	seen.add(rowId);
	edges.push(edge);
}

/**
 * Strengthen an already-accepted neighbour's ranking metadata when another edge
 * reaches it: keep the higher-weighted relation and the closer (lower) root seed.
 * No-op for seeds (which are not in the neighbour map).
 */
function bumpNeighborMeta(
	neighbors: Map<Id<'knowledgeEntries'>, ExpandedNeighbor>,
	id: Id<'knowledgeEntries'>,
	relation: RelationType,
	confidence: number,
	rootSeedIndex: number,
): void {
	const existing = neighbors.get(id);
	if (!existing) return;
	if (RELATION_WEIGHTS[relation] > RELATION_WEIGHTS[existing.relation]) {
		existing.relation = relation;
		existing.confidence = confidence;
	}
	if (rootSeedIndex < existing.rootSeedIndex) existing.rootSeedIndex = rootSeedIndex;
}
