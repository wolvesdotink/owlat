/**
 * Knowledge-graph analytics — graphify's "insight layer" (data access + reads).
 *
 * A 24h cron (`graphAnalyticsRecompute.recomputeStats`) walks the whole
 * `knowledgeEntries` / `knowledgeRelations` graph and caches ONE snapshot row
 * (`knowledgeGraphStats`) describing its shape: god nodes (degree hubs),
 * approximate communities (label propagation), the confidence distribution, and
 * the most "surprising" connections. THIS file owns the thin paginating queries
 * the action consumes, plus the member-only dashboard reads (`getGraphStats` /
 * `getSubgraph`); an admin pulls the redacted cross-contact detail via
 * `getCrossContactLinks`. The recompute pipeline + snapshot writer live in the
 * sibling `graphAnalyticsRecompute.ts` (file-size split).
 *
 * ★ SECURITY ★
 * This whole module is MEMBER-TRUSTED and ORG-WIDE. It NEVER feeds an AI /
 * retrieval context — it backs a dashboard a logged-in org member reads, exactly
 * like `knowledge/graph.ts:getEntry` already exposes a node's edges + neighbour
 * titles org-wide. That is why the `knowledgeRelations` reads here (`pageRelations`,
 * `getSubgraph`) are allowlisted in `scripts/check-graph-scope.sh` under rule (a)
 * (member-trusted publicQuery / system maintenance), NOT rule (b) (per-hop
 * `isContactScopeVisible`): there is no per-contact retrieval scope in play. The
 * per-node contact-isolation gate guards the contact-scoped AGENT DRAFT path
 * (`knowledge/graphTraversal.ts`); it does not apply to a member's own dashboard.
 *
 * ★ REDACTION ★
 * The one place contact isolation still bites the dashboard: an edge can join a
 * contact-A-only node to a contact-B-only node (a "cross-contact-disjoint" edge).
 * Surfacing such an edge in the member-visible `surprisingConnections` would draw
 * an A→B bridge in the UI, so those edges are REDACTED out of it and summarized
 * only as the aggregate `crossContactLinkCount`. Their endpoint detail lives in
 * `crossContactLinks`, which `getGraphStats` strips and only the role-gated
 * `getCrossContactLinks` adminQuery returns.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { publicQuery, adminQuery } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { isActiveOrgMember } from '../lib/sessionOrganization';
import { clamp } from '../lib/graphAnalyticsCompute';

/** Bounded BFS limits for the member subgraph viewer. */
const SUBGRAPH_MAX_NODES = 60;
const SUBGRAPH_PER_NODE_EDGE_CAP = 32;

/**
 * Explicit page-result shapes. The recompute action (sibling file) calls
 * `pageRelations` / `pageEntryConfidence` via ctx.runQuery; annotating those
 * call-sites with these exported types keeps their inferred return type from
 * becoming self-referential through the generated `api`.
 */
export interface RelationPage {
	page: {
		fromId: Id<'knowledgeEntries'>;
		toId: Id<'knowledgeEntries'>;
		relationType: Doc<'knowledgeRelations'>['relationType'];
	}[];
	continueCursor: string;
	isDone: boolean;
}
export interface EntryFacetPage {
	page: {
		id: Id<'knowledgeEntries'>;
		entryType: Doc<'knowledgeEntries'>['entryType'];
		title: string;
		confidence: number;
		contactIds: Id<'contacts'>[] | undefined;
		tags: string[] | undefined;
	}[];
	continueCursor: string;
	isDone: boolean;
}

// ============================================================
// Flag gate (action context) + thin pagination queries
// ============================================================

/**
 * Authoritative `ai.knowledge.analytics` gate for the recompute action. Actions
 * can't read the DB, so `recomputeStats` checks the flag through this query
 * (mirrors `graphTraversal.isGraphRetrievalEnabled`). No-op when off — kill switch.
 */
export const isAnalyticsEnabled = internalQuery({
	args: {},
	handler: async (ctx): Promise<boolean> => isFeatureEnabled(ctx, 'ai.knowledge.analytics'),
});

/**
 * One page of edges as thin `{ fromId, toId, relationType }` tuples. A direct
 * `knowledgeRelations` read (allowlisted in check-graph-scope.sh, rule a — system
 * analytics, never an AI context). Paginated so the action accumulates in memory
 * without `.collect()`-ing the table.
 */
export const pageRelations = internalQuery({
	args: { cursor: v.optional(v.string()), numItems: v.number() },
	handler: async (ctx, args): Promise<RelationPage> => {
		const page = await ctx.db
			.query('knowledgeRelations')
			.paginate({ cursor: args.cursor ?? null, numItems: args.numItems });
		return {
			page: page.page.map((r) => ({
				fromId: r.fromEntryId,
				toId: r.toEntryId,
				relationType: r.relationType,
			})),
			continueCursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

/**
 * One page of nodes as thin facets (NO embedding — that's fetched separately and
 * sparingly). Drops entries already past their TTL so the snapshot doesn't count
 * facts the decay cron will reap. The name keeps the spec's vocabulary even
 * though it carries a few extra facets the analytics math needs.
 */
export const pageEntryConfidence = internalQuery({
	args: { cursor: v.optional(v.string()), numItems: v.number() },
	handler: async (ctx, args): Promise<EntryFacetPage> => {
		const now = Date.now();
		const page = await ctx.db
			.query('knowledgeEntries')
			.paginate({ cursor: args.cursor ?? null, numItems: args.numItems });
		const rows: EntryFacetPage['page'] = [];
		for (const e of page.page) {
			// Drop entries past their TTL (the decay cron reaps them lazily) so the
			// snapshot doesn't count facts that are about to disappear.
			if (e.expiresAt !== undefined && e.expiresAt <= now) continue;
			rows.push({
				id: e._id,
				entryType: e.entryType,
				title: e.title,
				confidence: e.confidence,
				contactIds: e.contactIds,
				tags: e.tags,
			});
		}
		return { page: rows, continueCursor: page.continueCursor, isDone: page.isDone };
	},
});

/**
 * Embeddings for a bounded id set (the endpoints of the surprise candidates).
 * Skips entries without a real embedding. Reads `knowledgeEntries` only (not the
 * edge table), so it is outside the graph-scope guard's scope entirely.
 */
export const getEmbeddingsByIds = internalQuery({
	args: { ids: v.array(v.id('knowledgeEntries')) },
	handler: async (ctx, args): Promise<{ id: Id<'knowledgeEntries'>; embedding: number[] }[]> => {
		const out: { id: Id<'knowledgeEntries'>; embedding: number[] }[] = [];
		for (const id of args.ids) {
			const e = await ctx.db.get(id);
			if (e && e.embedding.length > 0) out.push({ id, embedding: e.embedding });
		}
		return out;
	},
});

// ============================================================
// Member-only reads (dashboard)
// ============================================================

/**
 * The cached snapshot, MEMBER-VISIBLE (cross-contact-disjoint edge detail
 * stripped — see REDACTION in the header). Flag-gated kill switch + soft member
 * floor: returns null when analytics is off, for anonymous callers, or for
 * non-members. Org-wide / member-trusted like `getEntry`; no per-contact scoping.
 */
export const getGraphStats = publicQuery({
	// public: soft-auth — org members only; returns null for anonymous/non-members
	args: {},
	handler: async (ctx) => {
		if (!(await isFeatureEnabled(ctx, 'ai.knowledge.analytics'))) return null;
		if (!(await isActiveOrgMember(ctx))) return null;
		const row = await ctx.db
			.query('knowledgeGraphStats')
			.withIndex('by_kind', (q) => q.eq('kind', 'graph'))
			.first();
		if (!row) return null;
		// REDACTION: drop the admin-only cross-contact edge detail; members see only
		// the aggregate crossContactLinkCount.
		const { crossContactLinks: _redacted, ...memberVisible } = row;
		return memberVisible;
	},
});

/**
 * A bounded subgraph (BFS, ≤2 hops) around one entry, for the dashboard's graph
 * explorer. Reuses `getEntry`'s member-trusted, org-wide read model — it is the
 * one edge-traversal read here (allowlisted in check-graph-scope.sh, rule a).
 * Flag-gated + soft member floor; returns empty for off/anonymous/non-member.
 */
export const getSubgraph = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: {
		entryId: v.id('knowledgeEntries'),
		depth: v.optional(v.number()),
		nodeLimit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const empty: {
			nodes: { id: Id<'knowledgeEntries'>; title: string; entryType: Doc<'knowledgeEntries'>['entryType']; confidence: number }[];
			edges: {
				fromId: Id<'knowledgeEntries'>;
				toId: Id<'knowledgeEntries'>;
				relationType: Doc<'knowledgeRelations'>['relationType'];
				confidence: number;
				// Coarse evidence tag (extracted / inferred / ambiguous) — the dashboard
				// canvas keys edge styling off it (solid / dashed / faint). Member-trusted
				// edge metadata, exactly like relationType/confidence already returned.
				confidenceTag: Doc<'knowledgeRelations'>['confidenceTag'];
			}[];
		} = { nodes: [], edges: [] };
		if (!(await isFeatureEnabled(ctx, 'ai.knowledge.analytics'))) return empty;
		if (!(await isActiveOrgMember(ctx))) return empty;

		const root = await ctx.db.get(args.entryId);
		if (!root) return empty;

		const depth = clamp(args.depth ?? 1, 1, 2);
		const nodeLimit = clamp(args.nodeLimit ?? SUBGRAPH_MAX_NODES, 1, SUBGRAPH_MAX_NODES);

		const nodes = new Map<string, (typeof empty.nodes)[number]>();
		const addNode = (e: Doc<'knowledgeEntries'>): void => {
			nodes.set(e._id, { id: e._id, title: e.title, entryType: e.entryType, confidence: e.confidence });
		};
		addNode(root);
		const edges = empty.edges;
		const seenEdge = new Set<string>();
		let frontier: Id<'knowledgeEntries'>[] = [args.entryId];

		for (let hop = 0; hop < depth; hop++) {
			const next: Id<'knowledgeEntries'>[] = [];
			for (const nodeId of frontier) {
				const outgoing = await ctx.db
					.query('knowledgeRelations')
					.withIndex('by_from', (q) => q.eq('fromEntryId', nodeId))
					.take(SUBGRAPH_PER_NODE_EDGE_CAP);
				const incoming = await ctx.db
					.query('knowledgeRelations')
					.withIndex('by_to', (q) => q.eq('toEntryId', nodeId))
					.take(SUBGRAPH_PER_NODE_EDGE_CAP);
				for (const edge of [...outgoing, ...incoming]) {
					const neighbourId = edge.fromEntryId === nodeId ? edge.toEntryId : edge.fromEntryId;
					if (!nodes.has(neighbourId)) {
						if (nodes.size >= nodeLimit) continue; // can't add neighbour → skip its edge too
						const neighbour = await ctx.db.get(neighbourId);
						if (!neighbour) continue;
						addNode(neighbour);
						next.push(neighbourId);
					}
					// Both endpoints are present now — record the edge once.
					if (!seenEdge.has(edge._id)) {
						seenEdge.add(edge._id);
						edges.push({
							fromId: edge.fromEntryId,
							toId: edge.toEntryId,
							relationType: edge.relationType,
							confidence: edge.confidence,
							confidenceTag: edge.confidenceTag,
						});
					}
				}
			}
			frontier = next;
			if (frontier.length === 0) break;
		}
		return { nodes: [...nodes.values()], edges };
	},
});

/**
 * ADMIN-only detail of the redacted cross-contact-disjoint edges (the edges
 * excluded from the member-visible `surprisingConnections`). Role-gated via
 * `adminQuery` (organization:manage); flag-gated. Returns [] when off / no snapshot.
 */
export const getCrossContactLinks = adminQuery({
	args: {},
	handler: async (ctx) => {
		if (!(await isFeatureEnabled(ctx, 'ai.knowledge.analytics'))) return [];
		const row = await ctx.db
			.query('knowledgeGraphStats')
			.withIndex('by_kind', (q) => q.eq('kind', 'graph'))
			.first();
		return row?.crossContactLinks ?? [];
	},
});
