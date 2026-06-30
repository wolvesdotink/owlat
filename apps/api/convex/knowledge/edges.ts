/**
 * Knowledge-graph edge construction — the deterministic ("structural") linker.
 *
 * When the extraction pipeline persists a batch of knowledge entries from one
 * source, the cheap, always-safe edges are knowable without an LLM: every entry
 * from the same message relates to its siblings, and to the knowledge already
 * extracted from the same conversation thread. `linkStructural` writes exactly
 * those `relates_to` edges (graphify's "deterministic pass"). The richer,
 * LLM-inferred edges are layered on separately (p3, gated by
 * `ai.knowledge.autoLink`).
 *
 * `upsertEdge` is the ONE shared edge writer: insert-or-merge keyed on the
 * (from, to, relationType) triple via the `by_pair` index, folding duplicates
 * together with the pure `mergeEdgeAttrs` rule so re-running ingestion is
 * idempotent.
 *
 * SECURITY: edges have no contact scope, and a dedup-merge unions `contactIds`,
 * so an unguarded edge could join a contact-A node to a contact-B-only node.
 * The linker refuses to draw an edge between two disjoint contact-specific nodes
 * (`contactScopesCanLink`) — the construction-time analogue of the per-node
 * `isContactScopeVisible` re-check every traversal must perform.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { isFeatureEnabled } from '../lib/featureFlags';
import { contactScopesCanLink } from '../lib/contactScope';
import { mergeEdgeAttrs, type EdgeAttrs } from '../lib/knowledgeEdges';
import {
	sourceTypeValidator,
	relationTypeValidator,
	edgeConfidenceTagValidator,
} from '../schema/knowledge';

/**
 * Largest clique the deterministic linker builds among a single ingest batch.
 * An n-entry batch produces n·(n-1)/2 edges; capping n keeps a pathological
 * extraction (dozens of facts from one message) from writing a quadratic blow-up
 * of rows in one mutation. Extra entries beyond the cap are simply not cliqued.
 */
export const STRUCTURAL_MAX_BATCH = 25;

/**
 * How many pre-existing same-thread entries each freshly-ingested entry links to.
 * Bounds the `by_thread` fan-out so a long-running conversation with hundreds of
 * accumulated knowledge rows can't make one ingest write an unbounded edge set.
 */
export const STRUCTURAL_THREAD_FANOUT = 25;

/**
 * Lift the mutable edge attributes off a stored relation row into the plain
 * {@link EdgeAttrs} shape {@link mergeEdgeAttrs} operates on.
 */
function edgeAttrsOf(rel: Doc<'knowledgeRelations'>): EdgeAttrs {
	return {
		confidence: rel.confidence,
		confidenceTag: rel.confidenceTag,
		provenance: rel.provenance,
		weight: rel.weight,
		rationale: rel.rationale,
	};
}

/**
 * Write a merged set of {@link EdgeAttrs} back onto an existing edge row and bump
 * its `updatedAt`. Shared by every insert-or-merge path so the patched column
 * list can't drift between the construction writer and the merge re-point.
 */
async function patchEdgeAttrs(
	ctx: MutationCtx,
	id: Id<'knowledgeRelations'>,
	attrs: EdgeAttrs,
	now: number,
): Promise<void> {
	await ctx.db.patch(id, {
		confidence: attrs.confidence,
		confidenceTag: attrs.confidenceTag,
		provenance: attrs.provenance,
		weight: attrs.weight,
		rationale: attrs.rationale,
		updatedAt: now,
	});
}

/**
 * The ONE shared edge writer: insert-or-merge a typed edge keyed on
 * (fromEntryId, toEntryId, relationType).
 *
 * Looks the pair up via `by_pair`; if a row with the same `relationType` already
 * exists it folds `attrs` into it with {@link mergeEdgeAttrs} (keeping the
 * strongest evidence + provenance) and bumps `updatedAt`, otherwise it inserts a
 * fresh row. Self-edges are meaningless (a node pointing at itself) and are
 * rejected with `null`. Returns the surviving row id.
 *
 * This is a plain ctx helper, not a mutation, so both the deterministic linker
 * here and the LLM inference pass (p3) route every edge write through the same
 * idempotent merge instead of each re-implementing dedup.
 */
export async function upsertEdge(
	ctx: MutationCtx,
	args: {
		fromEntryId: Id<'knowledgeEntries'>;
		toEntryId: Id<'knowledgeEntries'>;
		relationType: Doc<'knowledgeRelations'>['relationType'];
		attrs: EdgeAttrs;
	},
): Promise<Id<'knowledgeRelations'> | null> {
	if (args.fromEntryId === args.toEntryId) return null;

	const now = Date.now();
	const pair = await ctx.db
		.query('knowledgeRelations')
		.withIndex('by_pair', (q) =>
			q.eq('fromEntryId', args.fromEntryId).eq('toEntryId', args.toEntryId),
		)
		.collect(); // bounded: edges between one directed entry pair (≤ relationType count)
	const existing = pair.find((r) => r.relationType === args.relationType);

	if (existing) {
		await patchEdgeAttrs(ctx, existing._id, mergeEdgeAttrs(edgeAttrsOf(existing), args.attrs), now);
		return existing._id;
	}

	return await ctx.db.insert('knowledgeRelations', {
		fromEntryId: args.fromEntryId,
		toEntryId: args.toEntryId,
		relationType: args.relationType,
		confidence: args.attrs.confidence,
		confidenceTag: args.attrs.confidenceTag,
		provenance: args.attrs.provenance,
		weight: args.attrs.weight,
		rationale: args.attrs.rationale,
		createdAt: now,
		updatedAt: now,
	});
}

/**
 * Repoint an existing edge onto a new endpoint pair during a node merge, folding
 * it into any parallel edge that already connects the new pair.
 *
 * `knowledge.maintenance.mergeEntryInto` calls this when it moves a loser node's
 * edges onto the survivor. Three outcomes:
 *   - the repointed pair is a self-loop (newFrom === newTo) → the edge is
 *     meaningless, so it is deleted;
 *   - a DIFFERENT edge with the same (newFrom, newTo, relationType) already
 *     exists → `edge`'s evidence is folded into it with {@link mergeEdgeAttrs},
 *     its `updatedAt` is bumped, and the now-duplicate `edge` is deleted — the
 *     parallel edge a blind re-point would otherwise leave behind is collapsed;
 *   - otherwise → `edge`'s endpoints are patched in place (preserving its row id
 *     and `createdAt`, which the ambiguous-edge reaper keys on) and `updatedAt`
 *     is bumped.
 *
 * Shares the `by_pair` lookup + `mergeEdgeAttrs` merge rule with
 * {@link upsertEdge}; the only difference is it preserves the moved row when
 * there is no parallel edge instead of inserting a fresh one.
 */
export async function repointEdge(
	ctx: MutationCtx,
	edge: Doc<'knowledgeRelations'>,
	newFromEntryId: Id<'knowledgeEntries'>,
	newToEntryId: Id<'knowledgeEntries'>,
): Promise<void> {
	const now = Date.now();
	if (newFromEntryId === newToEntryId) {
		await ctx.db.delete(edge._id);
		return;
	}

	const pair = await ctx.db
		.query('knowledgeRelations')
		.withIndex('by_pair', (q) =>
			q.eq('fromEntryId', newFromEntryId).eq('toEntryId', newToEntryId),
		)
		.collect(); // bounded: edges between one directed entry pair (≤ relationType count)
	const existing = pair.find(
		(r) => r.relationType === edge.relationType && r._id !== edge._id,
	);

	if (existing) {
		await patchEdgeAttrs(
			ctx,
			existing._id,
			mergeEdgeAttrs(edgeAttrsOf(existing), edgeAttrsOf(edge)),
			now,
		);
		await ctx.db.delete(edge._id);
		return;
	}

	await ctx.db.patch(edge._id, {
		fromEntryId: newFromEntryId,
		toEntryId: newToEntryId,
		updatedAt: now,
	});
}

/**
 * The deterministic structural pass over a freshly-ingested batch of knowledge
 * entries. Scheduled fire-and-forget by `knowledge.extraction` after it persists
 * the entries from one source/message.
 *
 * Creates only fully-trusted `relates_to` edges (confidenceTag 'extracted',
 * confidence 1.0, provenance 'deterministic'):
 *   1. an all-pairs clique among the batch entries (capped at
 *      {@link STRUCTURAL_MAX_BATCH}) — siblings from the same source relate, and
 *   2. each batch entry → up to {@link STRUCTURAL_THREAD_FANOUT} pre-existing
 *      entries from the same conversation thread.
 *
 * Idempotent: every write goes through {@link upsertEdge}, so a re-run (cron
 * retry / migration restart) merges instead of duplicating. Gated on
 * `ai.knowledge` — the deterministic linker rides on the knowledge graph itself;
 * the LLM `autoLink` pass is scheduled separately by p3.
 *
 * Contact isolation: every candidate pair is checked with
 * `contactScopesCanLink` before an edge is drawn, so a same-thread entry scoped
 * to a different contact is never linked across the boundary.
 */
export const linkStructural = internalMutation({
	args: {
		entryIds: v.array(v.id('knowledgeEntries')),
		threadId: v.optional(v.id('conversationThreads')),
		sourceType: sourceTypeValidator,
		sourceId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		if (!(await isFeatureEnabled(ctx, 'ai.knowledge'))) return;

		// Cap the clique so a pathological batch can't write a quadratic edge set.
		const batchIds = args.entryIds.slice(0, STRUCTURAL_MAX_BATCH);
		const batch = (await Promise.all(batchIds.map((id) => ctx.db.get(id)))).filter(
			(d): d is Doc<'knowledgeEntries'> => d !== null,
		);
		if (batch.length === 0) return;

		// All deterministic structural edges are fully-trusted relates_to edges.
		const attrs: EdgeAttrs = {
			confidence: 1.0,
			confidenceTag: 'extracted',
			provenance: 'deterministic',
		};

		// (1) Clique among the same-source batch. Same-source entries share the
		// source's contactIds, so the scope check always passes here — it stays as
		// defense in depth in case a caller ever passes a mixed-scope batch.
		for (let i = 0; i < batch.length; i++) {
			for (let j = i + 1; j < batch.length; j++) {
				if (!contactScopesCanLink(batch[i]!.contactIds, batch[j]!.contactIds)) continue;
				await upsertEdge(ctx, {
					fromEntryId: batch[i]!._id,
					toEntryId: batch[j]!._id,
					relationType: 'relates_to',
					attrs,
				});
			}
		}

		// (2) Fan out to pre-existing same-thread knowledge, capped + scope-checked.
		if (args.threadId !== undefined) {
			const threadId = args.threadId;
			const neighbors = await ctx.db
				.query('knowledgeEntries')
				.withIndex('by_thread', (q) => q.eq('threadId', threadId))
				.take(STRUCTURAL_THREAD_FANOUT);
			const batchSet = new Set(batchIds);
			for (const entry of batch) {
				for (const neighbor of neighbors) {
					if (batchSet.has(neighbor._id)) continue; // siblings already cliqued above
					if (!contactScopesCanLink(entry.contactIds, neighbor.contactIds)) continue;
					await upsertEdge(ctx, {
						fromEntryId: entry._id,
						toEntryId: neighbor._id,
						relationType: 'relates_to',
						attrs,
					});
				}
			}
		}

		// Layer the LLM-inferred `autoLink` pass on top of the deterministic edges,
		// gated on `ai.knowledge.autoLink` (a child of `ai.knowledge`). Fire-and-forget
		// so the LLM round-trip never sits on extraction's critical path; the action
		// re-checks the flag (defense in depth) and is contact-scoped at construction.
		if (await isFeatureEnabled(ctx, 'ai.knowledge.autoLink')) {
			await ctx.scheduler.runAfter(0, internal.knowledge.edgeInference.inferRelations, {
				entryIds: batchIds,
			});
		}
	},
});

// ============================================================
// LLM edge-inference support (p3, gated on ai.knowledge.autoLink)
// ============================================================

/**
 * Re-check the `ai.knowledge.autoLink` flag from a `'use node'` action context.
 *
 * The LLM inference action (`knowledge.edgeInference.inferRelations`) is scheduled
 * by `linkStructural` only when the flag is on, but the flag can flip between the
 * schedule and the run, and an action can't read `instanceSettings` directly — so
 * the action bails through this query as its authoritative, defense-in-depth gate.
 */
export const isInferenceEnabled = internalQuery({
	args: {},
	handler: async (ctx): Promise<boolean> => {
		return await isFeatureEnabled(ctx, 'ai.knowledge.autoLink');
	},
});

/**
 * Which directed entry pairs among `ids` ALREADY carry an edge, as
 * `"<fromEntryId>:<toEntryId>"` keys. The LLM inference pass prunes its proposed
 * relations against this set so it never re-proposes (and re-merges into) a pair
 * the deterministic linker or a human already linked — graphify's "don't relitigate
 * known edges". Bounded: one `by_from` scan per node (outgoing edges per entry are
 * small), filtered to the in-scope node set.
 */
export const existingEdgePairs = internalQuery({
	args: {
		ids: v.array(v.id('knowledgeEntries')),
	},
	handler: async (ctx, args): Promise<string[]> => {
		const idSet = new Set(args.ids.map((id) => id as string));
		const pairs = new Set<string>();
		for (const id of args.ids) {
			const outgoing = await ctx.db
				.query('knowledgeRelations')
				.withIndex('by_from', (q) => q.eq('fromEntryId', id))
				.collect(); // bounded: outgoing edges for one entry (small)
			for (const rel of outgoing) {
				if (idSet.has(rel.toEntryId as string)) {
					pairs.add(`${rel.fromEntryId}:${rel.toEntryId}`);
				}
			}
		}
		return [...pairs];
	},
});

/**
 * Persist one LLM-inferred edge through the shared {@link upsertEdge} merge.
 *
 * The inference action computes the `confidenceTag` (via `tagForInferredConfidence`)
 * and passes the numeric `confidence`; this mutation stamps the fixed
 * `provenance: 'llm'` and sets `weight` to the confidence so graph-augmented
 * retrieval / analytics can rank LLM edges below the deterministic + manual ones
 * (the merge rule keeps the strongest provenance when an edge already exists).
 * Self-edges are rejected by `upsertEdge` (returns null).
 */
export const upsertInferred = internalMutation({
	args: {
		fromEntryId: v.id('knowledgeEntries'),
		toEntryId: v.id('knowledgeEntries'),
		relationType: relationTypeValidator,
		confidence: v.number(),
		confidenceTag: edgeConfidenceTagValidator,
		rationale: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'knowledgeRelations'> | null> => {
		return await upsertEdge(ctx, {
			fromEntryId: args.fromEntryId,
			toEntryId: args.toEntryId,
			relationType: args.relationType,
			attrs: {
				confidence: args.confidence,
				confidenceTag: args.confidenceTag,
				provenance: 'llm',
				weight: args.confidence,
				rationale: args.rationale,
			},
		});
	},
});
