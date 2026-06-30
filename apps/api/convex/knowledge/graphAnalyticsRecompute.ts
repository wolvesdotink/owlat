/**
 * Knowledge-graph analytics — the 24h recompute pipeline (cron entry point) and
 * the snapshot writer.
 *
 * Split from `knowledge/graphAnalytics.ts` (which owns the data-access internal
 * queries + the member-only dashboard reads) to keep each file under the
 * file-size ratchet. This file holds the heavy part: `recomputeStats` walks the
 * whole graph via the thin paginating queries in `graphAnalytics.ts`, accumulates
 * the shape in action memory (the `runKnowledgeDedup` idiom — never `.collect()`s
 * an unbounded table), runs the pure graph math from `lib/graphAnalyticsCompute`,
 * and persists ONE row through `writeStats`.
 *
 * It NEVER reads `knowledgeRelations` directly — it goes through
 * `graphAnalytics.pageRelations` — so it needs no graph-scope allowlist entry.
 * See the SECURITY / REDACTION notes in `graphAnalytics.ts`.
 */

import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import type { ActionCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { contactScopesCanLink } from '../lib/contactScope';
import { entryTypeValidator, relationTypeValidator } from '../schema/knowledge';
import {
	clamp,
	cosineSimilarity,
	confidenceStats,
	labelPropagation,
	communitySizesFromLabels,
	tagsDisjoint,
	surprisingScore,
} from '../lib/graphAnalyticsCompute';
import type { RelationPage, EntryFacetPage } from './graphAnalytics';

// ── Caps (keep the cached row << 1 MiB; bound the action's work). ──
/** Hard ceiling on nodes/edges the scan considers; hitting it sets `isTruncated`. */
const DEFAULT_MAX_NODES = 20_000;
const DEFAULT_MAX_EDGES = 50_000;
/** Rows pulled per pagination round-trip (mirrors the dedup cron's page size). */
const PAGE_SIZE = 500;
/** Output-array caps stored on the snapshot. */
const GOD_NODES_CAP = 50;
const COMMUNITY_SIZES_CAP = 20;
const SURPRISING_CAP = 50;
/** Candidate edges (per visibility class) scored for surprise, and the embedding
 *  fetch budget — keeps the getEmbeddingsByIds round-trip bounded. */
const SURPRISING_CANDIDATE_CAP = 200;
const MAX_EMBEDDING_FETCH = 256;
/** Label-propagation sweeps — enough to converge on real graphs, cheap in V8. */
const LPA_ITERATIONS = 8;
/** Confidence below which a node is "needs review" (decayed but not yet floored). */
const REVIEW_THRESHOLD = 0.3;

// Reusable validators for the cached snapshot's object arrays.
const godNodeValidator = v.object({
	entryId: v.id('knowledgeEntries'),
	title: v.string(),
	entryType: entryTypeValidator,
	degree: v.number(),
	inDegree: v.number(),
	outDegree: v.number(),
});
const connectionValidator = v.object({
	fromEntryId: v.id('knowledgeEntries'),
	toEntryId: v.id('knowledgeEntries'),
	fromTitle: v.string(),
	toTitle: v.string(),
	relationType: relationTypeValidator,
	score: v.number(),
});

/**
 * Upsert the SINGLE `knowledgeGraphStats` snapshot row (found/replaced via
 * `by_kind`). Sole writer of the table.
 */
export const writeStats = internalMutation({
	args: {
		computedAt: v.number(),
		nodeCount: v.number(),
		edgeCount: v.number(),
		isTruncated: v.boolean(),
		godNodes: v.array(godNodeValidator),
		confidenceBuckets: v.array(v.number()),
		confidenceMean: v.number(),
		confidenceMedian: v.number(),
		belowReviewThreshold: v.number(),
		communityCount: v.number(),
		communitySizes: v.array(v.number()),
		surprisingConnections: v.array(connectionValidator),
		crossContactLinkCount: v.number(),
		crossContactLinks: v.array(connectionValidator),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		const existing = await ctx.db
			.query('knowledgeGraphStats')
			.withIndex('by_kind', (q) => q.eq('kind', 'graph'))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, { ...args, updatedAt: now });
			return existing._id;
		}
		return await ctx.db.insert('knowledgeGraphStats', {
			kind: 'graph',
			...args,
			createdAt: now,
			updatedAt: now,
		});
	},
});

interface AnalyticsNode {
	id: Id<'knowledgeEntries'>;
	entryType: Doc<'knowledgeEntries'>['entryType'];
	title: string;
	confidence: number;
	contactIds: Id<'contacts'>[] | undefined;
	tags: string[] | undefined;
}
interface RawEdge {
	fromId: Id<'knowledgeEntries'>;
	toId: Id<'knowledgeEntries'>;
	relationType: Doc<'knowledgeRelations'>['relationType'];
}
interface SnapshotConnection {
	fromEntryId: Id<'knowledgeEntries'>;
	toEntryId: Id<'knowledgeEntries'>;
	fromTitle: string;
	toTitle: string;
	relationType: Doc<'knowledgeRelations'>['relationType'];
	score: number;
}

/**
 * Recompute the cached graph-analytics snapshot. No-op when
 * `ai.knowledge.analytics` is off. Scheduled by the 24h cron in `crons.ts`.
 * `maxNodes` / `maxEdges` default to the module caps and are tunable (tests pass
 * small caps to exercise the `isTruncated` path).
 */
export const recomputeStats = internalAction({
	args: {
		maxNodes: v.optional(v.number()),
		maxEdges: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (!(await ctx.runQuery(internal.knowledge.graphAnalytics.isAnalyticsEnabled, {}))) {
			return { skipped: true as const };
		}
		const maxNodes = clamp(args.maxNodes ?? DEFAULT_MAX_NODES, 1, DEFAULT_MAX_NODES);
		const maxEdges = clamp(args.maxEdges ?? DEFAULT_MAX_EDGES, 1, DEFAULT_MAX_EDGES);

		// ── Phase 1: scan nodes (thin facets, no embeddings). ──
		const nodes = new Map<string, AnalyticsNode>();
		let isTruncated = false;
		let entryCursor: string | null = null;
		scanEntries: for (;;) {
			const pageResult: EntryFacetPage = await ctx.runQuery(
				internal.knowledge.graphAnalytics.pageEntryConfidence,
				{ cursor: entryCursor ?? undefined, numItems: PAGE_SIZE },
			);
			for (const e of pageResult.page) {
				if (nodes.size >= maxNodes) {
					isTruncated = true;
					break scanEntries;
				}
				nodes.set(e.id, {
					id: e.id,
					entryType: e.entryType,
					title: e.title,
					confidence: e.confidence,
					contactIds: e.contactIds,
					tags: e.tags,
				});
			}
			if (pageResult.isDone) break;
			entryCursor = pageResult.continueCursor;
		}

		// ── Phase 2: scan edges; build degree + adjacency + surprise candidates. ──
		const inDeg = new Map<string, number>();
		const outDeg = new Map<string, number>();
		const adjacency = new Map<string, Set<string>>();
		const memberCandidates: RawEdge[] = [];
		const crossCandidates: RawEdge[] = [];
		let crossContactLinkCount = 0;
		let edgeCount = 0;
		let examined = 0;
		let relCursor: string | null = null;
		scanEdges: for (;;) {
			const pageResult: RelationPage = await ctx.runQuery(
				internal.knowledge.graphAnalytics.pageRelations,
				{ cursor: relCursor ?? undefined, numItems: PAGE_SIZE },
			);
			for (const r of pageResult.page) {
				if (examined >= maxEdges) {
					isTruncated = true;
					break scanEdges;
				}
				examined++;
				const a = nodes.get(r.fromId);
				const b = nodes.get(r.toId);
				// Endpoint outside the (possibly capped) node set: can't classify it.
				if (!a || !b) continue;
				edgeCount++;
				inDeg.set(r.toId, (inDeg.get(r.toId) ?? 0) + 1);
				outDeg.set(r.fromId, (outDeg.get(r.fromId) ?? 0) + 1);
				addAdjacency(adjacency, r.fromId, r.toId);

				const edge: RawEdge = { fromId: r.fromId, toId: r.toId, relationType: r.relationType };
				if (contactScopesCanLink(a.contactIds, b.contactIds)) {
					if (memberCandidates.length < SURPRISING_CANDIDATE_CAP) memberCandidates.push(edge);
				} else {
					crossContactLinkCount++;
					if (crossCandidates.length < SURPRISING_CANDIDATE_CAP) crossCandidates.push(edge);
				}
			}
			if (pageResult.isDone) break;
			relCursor = pageResult.continueCursor;
		}

		// ── Phase 3: derive. ──
		const godNodes = [...nodes.values()]
			.map((n) => {
				const inDegree = inDeg.get(n.id) ?? 0;
				const outDegree = outDeg.get(n.id) ?? 0;
				return {
					entryId: n.id,
					title: n.title,
					entryType: n.entryType,
					degree: inDegree + outDegree,
					inDegree,
					outDegree,
				};
			})
			.sort((x, y) => y.degree - x.degree || cmp(x.entryId, y.entryId))
			.slice(0, GOD_NODES_CAP);

		const confidences: number[] = [];
		let belowReviewThreshold = 0;
		for (const n of nodes.values()) {
			confidences.push(n.confidence);
			if (n.confidence < REVIEW_THRESHOLD) belowReviewThreshold++;
		}
		const stats = confidenceStats(confidences);

		const labels = labelPropagation([...nodes.keys()], adjacency, LPA_ITERATIONS);
		const allCommunitySizes = communitySizesFromLabels(labels);

		// Score surprise candidates: fetch endpoint embeddings once, bounded.
		const embById = await fetchCandidateEmbeddings(ctx, memberCandidates, crossCandidates);
		const scoreEdge = (e: RawEdge): SnapshotConnection | null => {
			const a = nodes.get(e.fromId);
			const b = nodes.get(e.toId);
			if (!a || !b) return null;
			const embA = embById.get(e.fromId);
			const embB = embById.get(e.toId);
			const dissimilarity = embA && embB ? 1 - cosineSimilarity(embA, embB) : 0;
			const crossCommunity = labels.get(e.fromId) !== labels.get(e.toId);
			return {
				fromEntryId: e.fromId,
				toEntryId: e.toId,
				fromTitle: a.title,
				toTitle: b.title,
				relationType: e.relationType,
				score: surprisingScore({ dissimilarity, crossCommunity, tagDisjoint: tagsDisjoint(a.tags, b.tags) }),
			};
		};
		const rankConnections = (candidates: RawEdge[]): SnapshotConnection[] => {
			const scored: SnapshotConnection[] = [];
			for (const e of candidates) {
				const c = scoreEdge(e);
				if (c !== null) scored.push(c);
			}
			scored.sort(
				(x, y) => y.score - x.score || cmp(x.fromEntryId, y.fromEntryId) || cmp(x.toEntryId, y.toEntryId),
			);
			return scored.slice(0, SURPRISING_CAP);
		};

		await ctx.runMutation(internal.knowledge.graphAnalyticsRecompute.writeStats, {
			computedAt: Date.now(),
			nodeCount: nodes.size,
			edgeCount,
			isTruncated,
			godNodes,
			confidenceBuckets: stats.buckets,
			confidenceMean: stats.mean,
			confidenceMedian: stats.median,
			belowReviewThreshold,
			communityCount: allCommunitySizes.length,
			communitySizes: allCommunitySizes.slice(0, COMMUNITY_SIZES_CAP),
			surprisingConnections: rankConnections(memberCandidates),
			crossContactLinkCount,
			crossContactLinks: rankConnections(crossCandidates),
		});

		return {
			skipped: false as const,
			nodeCount: nodes.size,
			edgeCount,
			isTruncated,
			communityCount: allCommunitySizes.length,
			crossContactLinkCount,
		};
	},
});

/** Undirected adjacency edge (both directions) for label propagation. */
function addAdjacency(adjacency: Map<string, Set<string>>, a: string, b: string): void {
	(adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
	(adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
}

/** Deterministic string compare (for stable tie-breaks). */
function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fetch embeddings for the (bounded, de-duplicated) endpoints of the surprise
 * candidates in one query round-trip. Capped at {@link MAX_EMBEDDING_FETCH} ids —
 * candidates whose endpoints fall outside the budget simply score with no
 * semantic-distance term (the analytics snapshot is explicitly approximate).
 */
async function fetchCandidateEmbeddings(
	ctx: ActionCtx,
	memberCandidates: RawEdge[],
	crossCandidates: RawEdge[],
): Promise<Map<string, number[]>> {
	const ids: Id<'knowledgeEntries'>[] = [];
	const seen = new Set<string>();
	for (const e of [...memberCandidates, ...crossCandidates]) {
		for (const id of [e.fromId, e.toId]) {
			if (seen.has(id) || ids.length >= MAX_EMBEDDING_FETCH) continue;
			seen.add(id);
			ids.push(id);
		}
	}
	if (ids.length === 0) return new Map();
	const rows = await ctx.runQuery(internal.knowledge.graphAnalytics.getEmbeddingsByIds, { ids });
	return new Map(rows.map((r) => [r.id as string, r.embedding]));
}
