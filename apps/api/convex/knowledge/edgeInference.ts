'use node';

/**
 * Knowledge-graph edge construction — the LLM ("semantic") inference pass.
 *
 * graphify's deterministic pass (`knowledge.edges.linkStructural`) writes the
 * cheap, always-safe `relates_to` edges. This pass layers the *richer* typed
 * edges on top: an LLM proposes `supports` / `contradicts` / `supersedes` /
 * `causes` / `blocks` relations (with a 0-1 confidence) between a freshly-ingested
 * anchor and its nearest knowledge neighbors. Scheduled fire-and-forget by
 * `linkStructural` only when `ai.knowledge.autoLink` is on; re-checks the flag
 * here (defense in depth) so a flip between schedule and run is honored.
 *
 * SECURITY (leak surface #2 — edge CONSTRUCTION): edges carry no contact scope,
 * so an inferred edge could covertly bridge a contact-A node to a contact-B-only
 * node. Two layers prevent that. (1) The candidate pool is drawn from a
 * CONTACT-SCOPED vector search — `scopeToContact` is a contactId (or
 * `'org-general-only'` for an org-general anchor), NEVER `'org-wide'`. (2) Because
 * that pool is unioned across all anchors (a candidate is only guaranteed visible
 * to SOME anchor, not the specific endpoint the LLM links it to), every persisted
 * edge is additionally gated by `contactScopesCanLink(from, to)` — the same
 * per-edge check `linkStructural` enforces — so the isolation invariant holds even
 * if a future caller passes a mixed-scope batch. Together these are the
 * construction-time analogue of the per-node `isContactScopeVisible` re-check
 * every retrieval traversal performs.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { z } from 'zod';
import { resolveLanguageModel } from '../lib/llmProvider';
import { runLlmObject } from '../lib/llm/dispatch';
import { recordLlmSpend } from '../analytics/llmUsage';
import { logInfo } from '../lib/runtimeLog';
import { RELATION_TYPES } from '../schema/knowledge';
import { tagForInferredConfidence } from '../lib/knowledgeEdges';
import { contactScopesCanLink } from '../lib/contactScope';
import { injectionRisk } from './extraction';

/**
 * How many nearest neighbors each anchor contributes to the candidate pool. A
 * small number keeps the inference prompt focused on the most-similar entries.
 */
const CANDIDATES_PER_ANCHOR = 5;

/**
 * Hard ceiling on the candidate pool across all anchors. Bounds the numbered list
 * the LLM ranks over (and the prompt size / token spend) regardless of batch size.
 */
const MAX_CANDIDATES = 15;

/**
 * Largest number of inferred edges persisted per run. A defensive cap so a
 * pathological LLM response can't write an unbounded edge set in one go.
 */
const MAX_INFERRED_PER_RUN = 20;

/**
 * The inference LLM references nodes by INDEX into the numbered anchors+candidates
 * list (never by raw Convex id — ids must never reach the model), so the schema is
 * integer indices + a typed relation + a 0-1 confidence + an optional short
 * rationale. `relationType` derives from the same `RELATION_TYPES` tuple the
 * Convex `relationTypeValidator` is built from, so the LLM-facing enum can't drift.
 */
const inferenceSchema = z.object({
	relations: z
		.array(
			z.object({
				from: z.number().int().describe('Index of the source node in the numbered list'),
				to: z.number().int().describe('Index of the target node in the numbered list'),
				relationType: z.enum(RELATION_TYPES),
				confidence: z.number().min(0).max(1).describe('How confident you are this relation holds'),
				rationale: z
					.string()
					.max(200)
					.optional()
					.describe('Brief reason the relation holds (<= 200 chars)'),
			})
		)
		.describe('Typed relations inferred between the numbered knowledge nodes'),
});

/**
 * Derive the contact scope a candidate search runs under from an anchor's
 * `contactIds`. A contact-linked anchor scopes to its (first) contact — keeping
 * org-general rows + that contact's rows; an org-general anchor scopes to
 * `'org-general-only'`. NEVER `'org-wide'`: that would let the candidate pool
 * (and any inferred edge) reach a different contact's data.
 */
function scopeForAnchor(anchor: Doc<'knowledgeEntries'>): Id<'contacts'> | 'org-general-only' {
	const contactIds = anchor.contactIds;
	if (contactIds && contactIds.length > 0) return contactIds[0]!;
	return 'org-general-only';
}

/**
 * Infer typed edges for a freshly-ingested batch of knowledge entries.
 *
 * 1. Re-check the `ai.knowledge.autoLink` flag (bail if off).
 * 2. Load the anchors and, for each, pull its nearest neighbors from a
 *    CONTACT-SCOPED vector search (the anchor's stored embedding — no re-embed).
 * 3. Prune pairs that already carry an edge; bail on any injection risk.
 * 4. ONE LLM call proposes typed relations by index; persist each through the
 *    shared `upsertInferred` merge (provenance `'llm'`, weight = confidence).
 * Errors are swallowed (mirrors extraction) — edge inference is best-effort and
 * must never derail ingestion.
 */
export const inferRelations = internalAction({
	args: {
		entryIds: v.array(v.id('knowledgeEntries')),
	},
	handler: async (ctx, args): Promise<void> => {
		// Authoritative, defense-in-depth flag gate (the schedule already gated, but
		// the flag can flip between schedule and run, and an action can't read it).
		if (!(await ctx.runQuery(internal.knowledge.edges.isInferenceEnabled, {}))) return;

		// Load the freshly-ingested anchors.
		const anchors = await ctx.runQuery(internal.knowledge.graph.getByIds, { ids: args.entryIds });
		if (anchors.length === 0) return;
		const anchorIds = new Set(anchors.map((a) => a._id as string));

		// CANDIDATE SELECTION — security gate #2. Each anchor's neighbors come from a
		// CONTACT-SCOPED vector search keyed on the anchor's STORED embedding (no
		// re-embed); the scope is the anchor's contact (or 'org-general-only'), NEVER
		// 'org-wide', so a neighbor — and any edge to it — can't bridge to another
		// contact's data.
		const candidatesById = new Map<string, Doc<'knowledgeEntries'>>();
		for (const anchor of anchors) {
			if (candidatesById.size >= MAX_CANDIDATES) break;
			const embedding = anchor.embedding;
			if (!embedding || embedding.length === 0) continue; // no stored vector → no neighbors
			const hits = await ctx.runAction(internal.knowledge.retrieval.semanticSearch, {
				embedding,
				scopeToContact: scopeForAnchor(anchor),
				limit: CANDIDATES_PER_ANCHOR,
			});
			for (const hit of hits) {
				const key = hit._id as string;
				if (anchorIds.has(key)) continue; // an anchor is never its own candidate
				if (!candidatesById.has(key)) candidatesById.set(key, hit);
				if (candidatesById.size >= MAX_CANDIDATES) break;
			}
		}

		// Numbered node list the LLM references by INDEX: anchors first, then candidates.
		const nodes: Doc<'knowledgeEntries'>[] = [...anchors, ...candidatesById.values()];
		if (nodes.length < 2) return; // nothing to relate

		// Prune pairs that already carry an edge so the pass never relitigates a link
		// the deterministic linker or a human already drew (and never re-merges into it).
		const existing = new Set(
			await ctx.runQuery(internal.knowledge.edges.existingEdgePairs, {
				ids: nodes.map((n) => n._id),
			})
		);

		// Defense in depth: never feed prompt-injected content into the inference LLM.
		const risk = injectionRisk(nodes.map((n) => `${n.title}\n${n.content}`).join('\n\n'));
		if (risk) {
			logInfo('[knowledge.autolink] skipped: injection risk in node content', { risk });
			return;
		}

		try {
			const numbered = nodes
				.map((n, i) => `[${i}] (${n.entryType}) ${n.title}: ${n.content}`)
				.join('\n');

			const model = await resolveLanguageModel(ctx, 'extract');
			const { object, tokenUsage, modelUsed } = await runLlmObject({
				model,
				schema: inferenceSchema,
				prompt: `You are building a knowledge graph. Below is a numbered list of knowledge entries. Identify meaningful TYPED relations between them, referencing each entry by its [index].

Relation types (direction matters — "from" relates TO "to"):
- supersedes: the "from" entry replaces/updates an older "to" entry
- contradicts: the "from" entry conflicts with the "to" entry
- supports: the "from" entry corroborates/reinforces the "to" entry
- causes: the "from" entry causes or leads to the "to" entry
- blocks: the "from" entry blocks or prevents the "to" entry
- relates_to: a generic association (prefer a more specific type when one fits)

Only propose a relation you are confident actually holds. Skip pairs that are merely about the same topic with no real relation. Do not relate an entry to itself.

Entries:
${numbered}`,
				temperature: 0.1,
			});
			logInfo('[knowledge.autolink] llm call', { tokenUsage, modelUsed, nodeCount: nodes.length });
			await recordLlmSpend(ctx, 'knowledge_autolink', tokenUsage, modelUsed);

			let written = 0;
			for (const rel of object.relations) {
				if (written >= MAX_INFERRED_PER_RUN) break;
				const from = nodes[rel.from];
				const to = nodes[rel.to];
				if (!from || !to) continue; // index out of range
				if (from._id === to._id) continue; // self-edge
				// Per-edge contact-isolation guard, mirroring linkStructural. The
				// candidate pool is unioned across all anchors, so a candidate is only
				// guaranteed visible to SOME anchor — not the specific endpoint the LLM
				// attaches it to. Refusing a disjoint contact-scope pair keeps the
				// per-edge isolation invariant regardless of batch composition (the
				// wired caller passes a single-contact batch, so this is defense in
				// depth against a future mixed-scope caller).
				if (!contactScopesCanLink(from.contactIds, to.contactIds)) continue;
				const pairKey = `${from._id}:${to._id}`;
				if (existing.has(pairKey)) continue; // already linked — don't re-merge
				await ctx.runMutation(internal.knowledge.edges.upsertInferred, {
					fromEntryId: from._id,
					toEntryId: to._id,
					relationType: rel.relationType,
					confidence: rel.confidence,
					confidenceTag: tagForInferredConfidence(rel.confidence),
					rationale: rel.rationale,
				});
				existing.add(pairKey); // dedupe within this batch too
				written++;
			}
		} catch (error) {
			// Mirror extraction: a single inference failure must never derail ingestion.
			// eslint-disable-next-line no-console
			console.error('[Knowledge Edge Inference] Failed:', error);
		}
	},
});
