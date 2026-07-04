/**
 * Knowledge Graph
 *
 * CRUD operations and search for typed knowledge entries.
 * Supports semantic search (vector), full-text search, and
 * contact-scoped retrieval.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { publicQuery, authedMutation } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { getMutationContext, isActiveOrgMember } from '../lib/sessionOrganization';
import { batchGet } from '../_utils/batchLoader';
import { sameContactScope } from '../lib/contactScope';
import {
	entryTypeValidator,
	sourceTypeValidator,
	relationTypeValidator,
	edgeConfidenceTagValidator,
	edgeProvenanceValidator,
	commitmentStatusValidator,
	COMMITMENT_ENTRY_TYPES,
	POLICY_ENTRY_TYPES,
	isCommitmentOpen,
} from '../schema/knowledge';

// ============================================================
// Contact junction helpers
// ============================================================

/**
 * Write the `knowledgeEntryContacts` junction rows that mirror an entry's
 * `contactIds`. The array lives on the entry for the reads that still want it
 * inline; the junction is the index-able copy `getByContact` queries. Call this
 * right after inserting an entry — the entry is brand-new, so there are no stale
 * junction rows to reconcile. For an in-place edit or teardown use
 * `syncEntryContacts` (delete-then-reinsert) instead.
 */
async function insertEntryContacts(
	ctx: MutationCtx,
	entryId: Id<'knowledgeEntries'>,
	contactIds: Id<'contacts'>[] | undefined,
): Promise<void> {
	if (!contactIds) return;
	// De-dup the input so a contactId repeated in the array yields one row.
	for (const contactId of new Set(contactIds)) {
		await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId });
	}
}

/**
 * Reconcile the `knowledgeEntryContacts` junction rows for an entry whose
 * `contactIds` may already have rows. Delete-then-reinsert, so it is correct for
 * an in-place `contactIds` edit (`updateEntry`) and teardown
 * (`contactIds = undefined` deletes all rows, used by `deleteEntry`). Mirrors
 * `semanticFiles.ts:syncFileContacts`.
 */
async function syncEntryContacts(
	ctx: MutationCtx,
	entryId: Id<'knowledgeEntries'>,
	contactIds: Id<'contacts'>[] | undefined,
): Promise<void> {
	const existing = await ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_entry', (q) => q.eq('entryId', entryId))
		.collect(); // bounded: junction rows for one entry (contacts per entry)
	for (const row of existing) await ctx.db.delete(row._id);
	// De-dup so a contactId repeated in the array yields one row.
	for (const contactId of new Set(contactIds ?? [])) {
		await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId });
	}
}

// ============================================================
// Queries
// ============================================================

/**
 * Search knowledge entries by text query (full-text search)
 */
export const search = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: {
		searchQuery: v.string(),
		entryType: v.optional(entryTypeValidator),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'ai.knowledge');
		if (!(await isActiveOrgMember(ctx))) return [];

		const limit = args.limit ?? 25;

		let searchQuery = ctx.db
			.query('knowledgeEntries')
			.withSearchIndex('search_knowledge', (q) => {
				let sq = q.search('searchableText', args.searchQuery);
				if (args.entryType) {
					sq = sq.eq('entryType', args.entryType);
				}
				return sq;
			});

		return await searchQuery.take(limit);
	},
});

/**
 * Get knowledge entries by type
 */
export const listByType = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: {
		entryType: entryTypeValidator,
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (!(await isActiveOrgMember(ctx))) return [];

		return await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_entry_type', (q) => q.eq('entryType', args.entryType))
			.order('desc')
			.take(args.limit ?? 50);
	},
});

/**
 * List knowledge entries of every type, newest first. Powers the "All" tab,
 * which `listByType` can't serve — that query is keyed by a single `entryType`
 * (the `by_entry_type` index), so the UI fell back to 'fact' and the All tab
 * silently showed only facts.
 */
export const listAll = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (!(await isActiveOrgMember(ctx))) return [];

		return await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_created_at')
			.order('desc')
			.take(args.limit ?? 50);
	},
});

/**
 * Get a single knowledge entry with its relations
 */
export const getEntry = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: {
		entryId: v.id('knowledgeEntries'),
	},
	handler: async (ctx, args) => {
		if (!(await isActiveOrgMember(ctx))) return null;

		const entry = await ctx.db.get(args.entryId);
		if (!entry) return null;

		// Get outgoing relations
		const outgoing = await ctx.db
			.query('knowledgeRelations')
			.withIndex('by_from', (q) => q.eq('fromEntryId', args.entryId))
			.collect();

		// Get incoming relations
		const incoming = await ctx.db
			.query('knowledgeRelations')
			.withIndex('by_to', (q) => q.eq('toEntryId', args.entryId))
			.collect();

		// Resolve the related entries' titles so the UI can render readable links
		// instead of raw Convex ids.
		const relatedIds = [...outgoing.map((r) => r.toEntryId), ...incoming.map((r) => r.fromEntryId)];
		const relatedDocs = await batchGet(ctx, relatedIds);
		const relatedEntries: Record<string, { title: string; entryType: string }> = {};
		for (const [id, doc] of relatedDocs) {
			// All ids came from knowledgeRelations, so every hit is a knowledgeEntry.
			const kdoc = doc as Doc<'knowledgeEntries'> | null;
			if (kdoc) relatedEntries[id] = { title: kdoc.title, entryType: kdoc.entryType };
		}

		return { entry, outgoing, incoming, relatedEntries };
	},
});

/**
 * Get knowledge entries linked to a specific contact
 */
export const getByContact = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: {
		contactId: v.id('contacts'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (!(await isActiveOrgMember(ctx))) return [];

		const limit = args.limit ?? 20;
		const now = Date.now();

		// Query the index-able `knowledgeEntryContacts` mirror by contact, then
		// hydrate the entries. Complete (no 500-row truncation) and O(matches),
		// not a scan of the newest 500 entries filtered in JS.
		const links = await ctx.db
			.query('knowledgeEntryContacts')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: junction rows for one contact (knowledge per person)

		const entryMap = await batchGet<Doc<'knowledgeEntries'>, 'knowledgeEntries'>(
			ctx,
			links.map((link) => link.entryId),
		);

		return [...entryMap.values()]
			.filter(
				(e): e is Doc<'knowledgeEntries'> =>
					e !== null && !(e.expiresAt !== undefined && e.expiresAt < now),
			)
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit);
	},
});

// ============================================================
// Mutations
// ============================================================

/**
 * Create a new knowledge entry.
 *
 * Org member only: knowledge entries feed the agent's drafting pipeline and
 * persist sensitive content (decisions, preferences, relationships). The
 * org-membership floor blocks bare-identity callers from poisoning the graph;
 * an in-scope role check isn't required because every org member legitimately
 * authors knowledge today.
 */
// all-members: any org member can author knowledge; admin-only would block the AI assistant's primary write path
export const createEntry = authedMutation({
	args: {
		entryType: entryTypeValidator,
		title: v.string(),
		content: v.string(),
		sourceType: sourceTypeValidator,
		sourceId: v.optional(v.string()),
		contactIds: v.optional(v.array(v.id('contacts'))),
		threadId: v.optional(v.id('conversationThreads')),
		confidence: v.optional(v.number()),
		tags: v.optional(v.array(v.string())),
		expiresAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getMutationContext(ctx);

		const now = Date.now();

		const entryId = await ctx.db.insert('knowledgeEntries', {
			entryType: args.entryType,
			title: args.title,
			content: args.content,
			sourceType: args.sourceType,
			sourceId: args.sourceId,
			contactIds: args.contactIds,
			threadId: args.threadId,
			embedding: [], // Will be populated by extraction pipeline
			confidence: args.confidence ?? 0.8,
			lastValidatedAt: now,
			expiresAt: args.expiresAt,
			tags: args.tags,
			searchableText: `${args.title} ${args.content}`,
			createdAt: now,
			updatedAt: now,
		});

		// Mirror contactIds into the index-able junction (powers getByContact).
		await insertEntryContacts(ctx, entryId, args.contactIds);

		return entryId;
	},
});

/**
 * Edit an existing knowledge entry's user-authored fields.
 *
 * The remedy for a typo'd or wrong manual entry: without it an org member could
 * author knowledge but never correct it, and the wrong fact would keep feeding
 * the agent's drafting context until decay/expiry. Only the fields a human can
 * meaningfully set are editable — `embedding` / `searchableText` are derived, and
 * `searchableText` is recomputed from `title` + `content` so edits stay findable.
 * Editing counts as a re-validation, so `lastValidatedAt` is stamped.
 */
// all-members: any org member can correct knowledge they author; mirrors createEntry's write tier
export const updateEntry = authedMutation({
	args: {
		entryId: v.id('knowledgeEntries'),
		entryType: v.optional(entryTypeValidator),
		title: v.optional(v.string()),
		content: v.optional(v.string()),
		sourceType: v.optional(sourceTypeValidator),
		contactIds: v.optional(v.array(v.id('contacts'))),
		confidence: v.optional(v.number()),
		tags: v.optional(v.array(v.string())),
		expiresAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getMutationContext(ctx);

		const entry = await ctx.db.get(args.entryId);
		if (!entry) return null;

		const now = Date.now();
		const patch: Partial<Doc<'knowledgeEntries'>> = {
			updatedAt: now,
			lastValidatedAt: now,
		};
		if (args.entryType !== undefined) patch.entryType = args.entryType;
		if (args.title !== undefined) patch.title = args.title;
		if (args.content !== undefined) patch.content = args.content;
		if (args.sourceType !== undefined) patch.sourceType = args.sourceType;
		if (args.contactIds !== undefined) patch.contactIds = args.contactIds;
		if (args.confidence !== undefined) patch.confidence = args.confidence;
		if (args.tags !== undefined) patch.tags = args.tags;
		if (args.expiresAt !== undefined) patch.expiresAt = args.expiresAt;

		// Recompute the FTS searchField from the (possibly new) title + content so
		// the edit stays findable via `search` / `ftsRankedIds`.
		const nextTitle = args.title ?? entry.title;
		const nextContent = args.content ?? entry.content;
		patch.searchableText = `${nextTitle} ${nextContent}`;

		await ctx.db.patch(args.entryId, patch);

		// Reconcile the index-able junction when contactIds is edited in place.
		if (args.contactIds !== undefined) {
			await syncEntryContacts(ctx, args.entryId, args.contactIds);
		}

		// Return the edited id (a non-undefined success sentinel) so the web
		// `useBackendOperation` caller can tell a void success from the `undefined`
		// it returns on failure — otherwise the edit modal never closes.
		return args.entryId;
	},
});

/**
 * Permanently delete a knowledge entry and tear down everything that points at
 * it: the contact junction rows that mirror its `contactIds`, plus the
 * `knowledgeRelations` in both directions (the entry would otherwise leave
 * dangling relation rows that `getEntry` can no longer resolve). The user-facing
 * remedy for a wrong/duplicate manual entry that would otherwise persist until
 * decay/expiry.
 *
 * Relation teardown is paginated so a hub node with thousands of relations can't
 * blow the mutation transaction budget, and — mirroring the decay/expiry cron and
 * the merge path — the entry row itself is only deleted once *both* directions are
 * fully drained. That invariant matters: nothing else ever revisits a deleted
 * entry's relations (the cron iterates live `knowledgeEntries` only), so deleting
 * the entry while relations remain would permanently leak dangling
 * `knowledgeRelations` rows. In practice manual entries never approach the cap, so
 * this drains in a single pass.
 */
// all-members: any org member can delete knowledge they author; mirrors createEntry's write tier
export const deleteEntry = authedMutation({
	args: {
		entryId: v.id('knowledgeEntries'),
	},
	handler: async (ctx, args) => {
		await getMutationContext(ctx);

		const entry = await ctx.db.get(args.entryId);
		if (!entry) return null;

		// Tear down the contact junction mirror first so no orphan rows survive.
		await syncEntryContacts(ctx, args.entryId, undefined);

		// Drain relations in both directions in capped pages. Looping until a page
		// comes back short guarantees we never leave the entry with dangling
		// relation rows — there is no other sweep that would reap them later.
		const RELATION_DELETE_PAGE = 500;
		const drainDirection = async (
			index: 'by_from' | 'by_to',
			field: 'fromEntryId' | 'toEntryId',
		): Promise<void> => {
			for (;;) {
				const page = await ctx.db
					.query('knowledgeRelations')
					.withIndex(index, (q) => q.eq(field, args.entryId))
					.take(RELATION_DELETE_PAGE);
				for (const rel of page) {
					await ctx.db.delete(rel._id);
				}
				if (page.length < RELATION_DELETE_PAGE) break;
			}
		};
		await drainDirection('by_from', 'fromEntryId');
		await drainDirection('by_to', 'toEntryId');

		await ctx.db.delete(args.entryId);

		// Return a non-undefined success sentinel so the web `useBackendOperation`
		// caller can distinguish this void success from the `undefined` it returns
		// on failure — otherwise the success toast + redirect never fire.
		return true;
	},
});

/**
 * Update a knowledge entry's confidence (internal, for decay/boost)
 */
export const updateConfidence = internalMutation({
	args: {
		entryId: v.id('knowledgeEntries'),
		confidence: v.number(),
		lastValidatedAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.entryId, {
			confidence: args.confidence,
			lastValidatedAt: args.lastValidatedAt ?? Date.now(),
			updatedAt: Date.now(),
		});
	},
});

/**
 * Save a knowledge entry from the agent pipeline (internal)
 */
export const saveEntry = internalMutation({
	args: {
		entryType: entryTypeValidator,
		title: v.string(),
		content: v.string(),
		sourceType: sourceTypeValidator,
		sourceId: v.optional(v.string()),
		contactIds: v.optional(v.array(v.id('contacts'))),
		threadId: v.optional(v.id('conversationThreads')),
		embedding: v.array(v.float64()),
		embeddingModel: v.optional(v.string()),
		embeddingGeneratedAt: v.optional(v.number()),
		confidence: v.number(),
		tags: v.optional(v.array(v.string())),
		expiresAt: v.optional(v.number()),
		// Deterministic sha256 of normalizeForHash(title, content), computed by the
		// 'use node' extraction action. Enables the cross-source write-dedup leg
		// below (and the deterministic linker's exact-dup lookups).
		contentHash: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		// Write-level idempotency, leg 1 — same source: if an entry from the same
		// source already exists with this title, return it instead of inserting a
		// duplicate. This closes the cross-action race where two extractions of the
		// same message/file (e.g. a cron retry that overlaps the first run) both
		// pass their `countBySource` pre-check and then both write — the second
		// writer's reads conflict with the first's committed inserts under Convex
		// OCC, so it sees them here and no-ops.
		if (args.sourceId) {
			const fromSource = await ctx.db
				.query('knowledgeEntries')
				.withIndex('by_source', (q) =>
					q.eq('sourceType', args.sourceType).eq('sourceId', args.sourceId),
				)
				.collect(); // bounded: entries extracted from a single source (small)
			const dup = fromSource.find((e) => e.title === args.title);
			// The duplicate already carries its junction rows from its first
			// insert, so no junction write is needed on this no-op return.
			if (dup) return dup._id;
		}
		// Write-level idempotency, leg 2 — cross-source exact content: if a
		// byte-identical entry (same normalized title+content → same contentHash)
		// already exists with the SAME contact scope, return it instead of writing
		// a second copy. Caught via the `by_content_hash` index, this dedups the
		// same fact restated in a different message/file. The scope match
		// (sameContactScope) is mandatory: folding an org-general write into a
		// contact-A row (or vice versa) would silently widen/narrow the fact's
		// contact visibility, so cross-scope hashes are kept as distinct rows.
		if (args.contentHash) {
			const byHash = await ctx.db
				.query('knowledgeEntries')
				.withIndex('by_content_hash', (q) => q.eq('contentHash', args.contentHash))
				.collect(); // bounded: entries sharing one content hash (this dedup keeps it ~1)
			const dup = byHash.find((e) => sameContactScope(e.contactIds, args.contactIds));
			if (dup) return dup._id;
		}
		const entryId = await ctx.db.insert('knowledgeEntries', {
			...args,
			searchableText: `${args.title} ${args.content}`,
			lastValidatedAt: now,
			createdAt: now,
			updatedAt: now,
		});

		// Mirror contactIds into the index-able junction (powers getByContact).
		await insertEntryContacts(ctx, entryId, args.contactIds);

		return entryId;
	},
});

/**
 * Create a relation between two knowledge entries (internal, for the pipeline /
 * agent + tests). The public author path is `addRelation` below.
 */
export const createRelation = internalMutation({
	args: {
		fromEntryId: v.id('knowledgeEntries'),
		toEntryId: v.id('knowledgeEntries'),
		relationType: relationTypeValidator,
		// Optional edge evidence. Omitted ⇒ the manual/curated defaults below (a
		// directly-authored, fully-trusted edge). The deterministic/LLM linkers
		// pass richer attrs; for idempotent insert-or-merge they go through
		// `knowledge.edges.upsertEdge` instead of this raw insert.
		confidenceTag: v.optional(edgeConfidenceTagValidator),
		confidence: v.optional(v.number()),
		provenance: v.optional(edgeProvenanceValidator),
		weight: v.optional(v.number()),
		rationale: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert('knowledgeRelations', {
			fromEntryId: args.fromEntryId,
			toEntryId: args.toEntryId,
			relationType: args.relationType,
			confidenceTag: args.confidenceTag ?? 'extracted',
			confidence: args.confidence ?? 1.0,
			provenance: args.provenance ?? 'manual',
			weight: args.weight,
			rationale: args.rationale,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Author a typed edge between two knowledge entries from the dashboard.
 *
 * This is the user-facing write path for the knowledge graph's relations: until
 * it existed, `knowledgeRelations` was read-but-never-written outside the
 * pipeline/tests, so the "navigable graph" the UI advertises was always a
 * disconnected set of nodes. Validates that both endpoints exist and are
 * distinct (a self-edge is meaningless and would render as a node pointing at
 * itself), and de-dupes an identical edge so repeated clicks don't pile up rows.
 */
// all-members: any org member can curate knowledge relations; mirrors createEntry's write tier
export const addRelation = authedMutation({
	args: {
		fromEntryId: v.id('knowledgeEntries'),
		toEntryId: v.id('knowledgeEntries'),
		relationType: relationTypeValidator,
	},
	handler: async (ctx, args) => {
		await getMutationContext(ctx);

		if (args.fromEntryId === args.toEntryId) {
			throw new Error('A knowledge entry cannot be related to itself.');
		}

		const from = await ctx.db.get(args.fromEntryId);
		const to = await ctx.db.get(args.toEntryId);
		if (!from || !to) {
			throw new Error('Both knowledge entries must exist to relate them.');
		}

		// De-dupe an identical edge (same direction + type) so re-clicking "Add"
		// doesn't accumulate duplicate rows the detail page would render twice.
		const existing = await ctx.db
			.query('knowledgeRelations')
			.withIndex('by_from', (q) => q.eq('fromEntryId', args.fromEntryId))
			.collect(); // bounded: outgoing relations for one entry (manually curated, small)
		const dup = existing.find(
			(r) => r.toEntryId === args.toEntryId && r.relationType === args.relationType,
		);
		if (dup) return dup._id;

		const now = Date.now();
		// A dashboard-authored edge is a fully-trusted manual edge.
		return await ctx.db.insert('knowledgeRelations', {
			fromEntryId: args.fromEntryId,
			toEntryId: args.toEntryId,
			relationType: args.relationType,
			confidenceTag: 'extracted',
			confidence: 1.0,
			provenance: 'manual',
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * Remove a single relation row by id. The remedy for a wrong/duplicate edge that
 * would otherwise persist on the graph forever (relations are only otherwise
 * reaped when one of their endpoint entries is deleted). Idempotent: a no-op if
 * the row was already gone.
 */
// all-members: any org member can curate knowledge relations; mirrors createEntry's write tier
export const removeRelation = authedMutation({
	args: {
		relationId: v.id('knowledgeRelations'),
	},
	handler: async (ctx, args) => {
		await getMutationContext(ctx);

		const relation = await ctx.db.get(args.relationId);
		if (!relation) return null;

		await ctx.db.delete(args.relationId);

		// Non-undefined success sentinel so the web `useBackendOperation` caller can
		// tell a void success from the `undefined` it returns on failure.
		return true;
	},
});

// ============================================================
// Curated policy / FAQ authoring surface
// ============================================================

/** Validator for the curated entry types (policy / faq). */
const policyEntryTypeValidator = v.union(...POLICY_ENTRY_TYPES.map((t) => v.literal(t)));

/**
 * Author (or edit) a curated canonical answer — the minimal FAQ surface.
 *
 * Until curated answers existed, a policy question ("what's your returns
 * policy?") competed with scraped facts in the same RRF pool and could be
 * outranked by noise. A curated entry is written with `sourceType: 'curated'` and
 * `isAuthoritative: true`, so retrieval ranks it ahead of scraped facts
 * (lib/knowledgePrecedence.ts). Org-general by design (no contactIds) — a policy
 * applies to everyone. Passing `entryId` edits an existing curated entry in place
 * (the fix path for a wrong/stale answer). Embedding stays empty here and is
 * filled by the extraction/embedding pipeline; the FTS leg works immediately from
 * `searchableText`, so a fresh policy is retrievable at once.
 */
// all-members: any org member can curate canonical answers; mirrors createEntry's write tier
export const createPolicyEntry = authedMutation({
	args: {
		entryId: v.optional(v.id('knowledgeEntries')),
		entryType: v.optional(policyEntryTypeValidator),
		title: v.string(),
		content: v.string(),
		tags: v.optional(v.array(v.string())),
		expiresAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getMutationContext(ctx);

		if (args.title.trim().length === 0 || args.content.trim().length === 0) {
			throw new Error('A curated answer needs both a question and an answer.');
		}

		const now = Date.now();
		const entryType = args.entryType ?? 'faq';
		const searchableText = `${args.title} ${args.content}`;

		if (args.entryId) {
			const existing = await ctx.db.get(args.entryId);
			if (!existing) return null;
			await ctx.db.patch(args.entryId, {
				entryType,
				title: args.title,
				content: args.content,
				sourceType: 'curated',
				isAuthoritative: true,
				tags: args.tags,
				expiresAt: args.expiresAt,
				searchableText,
				lastValidatedAt: now,
				updatedAt: now,
			});
			return args.entryId;
		}

		return await ctx.db.insert('knowledgeEntries', {
			entryType,
			title: args.title,
			content: args.content,
			sourceType: 'curated',
			isAuthoritative: true,
			embedding: [], // filled by the embedding pipeline; FTS works immediately
			confidence: 1.0, // a human-authored canonical answer is fully trusted
			lastValidatedAt: now,
			expiresAt: args.expiresAt,
			tags: args.tags,
			searchableText,
			createdAt: now,
			updatedAt: now,
		});
	},
});

/**
 * List curated canonical answers (policy / faq), newest first — the read side of
 * the FAQ authoring surface.
 */
export const listPolicies = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		if (!(await isActiveOrgMember(ctx))) return [];

		const limit = args.limit ?? 100;
		const out: Doc<'knowledgeEntries'>[] = [];
		for (const entryType of POLICY_ENTRY_TYPES) {
			const rows = await ctx.db
				.query('knowledgeEntries')
				.withIndex('by_entry_type', (q) => q.eq('entryType', entryType))
				.order('desc')
				.take(limit);
			// Only human-curated canonical answers belong in the FAQ surface. The
			// extraction pipeline can emit `policy`/`faq` entries typed by the LLM
			// (sourceType 'agent_extracted', never authoritative); those must not
			// intermix with hand-authored answers here.
			for (const row of rows) {
				if (row.sourceType === 'curated' && row.isAuthoritative === true) {
					out.push(row);
				}
			}
		}
		out.sort((a, b) => b.createdAt - a.createdAt);
		return out.slice(0, limit);
	},
});

/**
 * Set the lifecycle status of a commitment (`decision` / `action_item`) so a
 * fulfilled or cancelled promise stops surfacing in the open-commitments recall.
 * The human remedy for "we already delivered X" — without it a satisfied
 * commitment would keep leading the briefing until decay/expiry.
 */
// all-members: any org member can resolve a commitment; mirrors createEntry's write tier
export const setCommitmentStatus = authedMutation({
	args: {
		entryId: v.id('knowledgeEntries'),
		commitmentStatus: commitmentStatusValidator,
		dueAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await getMutationContext(ctx);

		const entry = await ctx.db.get(args.entryId);
		if (!entry) return null;

		const now = Date.now();
		const patch: Partial<Doc<'knowledgeEntries'>> = {
			commitmentStatus: args.commitmentStatus,
			updatedAt: now,
			lastValidatedAt: now,
		};
		if (args.dueAt !== undefined) patch.dueAt = args.dueAt;
		await ctx.db.patch(args.entryId, patch);
		return args.entryId;
	},
});

// ============================================================
// Internal Queries (for agent pipeline)
// ============================================================

/**
 * Count knowledge entries already extracted from a given source. Lets the
 * live extractors (`extraction.extractFromMessage` / `extractFromFile`) be
 * idempotent — a message re-run through the pipeline (cron retry) or a file
 * reprocessed by the backfill cron won't duplicate its knowledge entries.
 */
export const countBySource = internalQuery({
	args: {
		sourceType: sourceTypeValidator,
		sourceId: v.string(),
	},
	handler: async (ctx, args): Promise<number> => {
		const existing = await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_source', (q) =>
				q.eq('sourceType', args.sourceType).eq('sourceId', args.sourceId),
			)
			.take(1);
		return existing.length;
	},
});

/**
 * Fetch knowledge entries by a list of ids, preserving the input order.
 *
 * Used to hydrate the documents returned by a vector search: `ctx.vectorSearch`
 * (action-only) yields `{ _id, _score }` hits, and this query resolves them to
 * full documents. Entries that no longer exist are skipped. See
 * `knowledge/retrieval.ts:semanticSearch` for the action that calls this.
 */
export const getByIds = internalQuery({
	args: {
		ids: v.array(v.id('knowledgeEntries')),
	},
	handler: async (ctx, args) => {
		const out: Doc<'knowledgeEntries'>[] = [];
		for (const id of args.ids) {
			const entry = await ctx.db.get(id);
			if (entry) out.push(entry);
		}
		return out;
	},
});

/**
 * Contact-scoped OPEN-commitments recall for the agent's context step.
 *
 * A promise we owe a contact — an `action_item` ("we'll ship X by Friday") or a
 * communicated `decision` — is durable grounding the draft must honour, yet the
 * semantic retrieval leg only surfaces it when the NEW inbound restates it, which
 * is exactly when it's least needed. This pulls those commitments by CONTACT
 * SCOPE, independent of similarity, filtered to the still-open ones
 * (`isCommitmentOpen`; a `fulfilled` / `cancelled` commitment drops out). Ordered
 * soonest-due first (undated last), then newest, so the most pressing promise
 * leads. Internal: the caller (context_retrieval) has already resolved + scoped
 * the contact, so no feature/membership gate here.
 */
export const getOpenCommitmentsByContact = internalQuery({
	args: {
		contactId: v.id('contacts'),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<Doc<'knowledgeEntries'>[]> => {
		const limit = args.limit ?? 10;
		const now = Date.now();

		const links = await ctx.db
			.query('knowledgeEntryContacts')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.collect(); // bounded: junction rows for one contact (knowledge per person)

		const entryMap = await batchGet<Doc<'knowledgeEntries'>, 'knowledgeEntries'>(
			ctx,
			links.map((link) => link.entryId),
		);

		const commitmentTypes = new Set<string>(COMMITMENT_ENTRY_TYPES);
		const open: Doc<'knowledgeEntries'>[] = [];
		for (const entry of entryMap.values()) {
			if (entry === null) continue;
			// Honour TTL at read time (the indexes hold expired rows until the decay
			// cron reaps them).
			if (entry.expiresAt !== undefined && entry.expiresAt < now) continue;
			if (!commitmentTypes.has(entry.entryType)) continue;
			if (!isCommitmentOpen(entry.commitmentStatus)) continue;
			open.push(entry);
		}

		open.sort((a, b) => {
			// Soonest promised-by first; undated commitments sort after dated ones.
			const aDue = a.dueAt ?? Number.POSITIVE_INFINITY;
			const bDue = b.dueAt ?? Number.POSITIVE_INFINITY;
			if (aDue !== bDue) return aDue - bDue;
			return b.createdAt - a.createdAt;
		});

		return open.slice(0, limit);
	},
});

/**
 * Record a recall hit on the given entries: bump `accessCount` and stamp
 * `lastAccessedAt`. Scheduled fire-and-forget by knowledge.retrieval so the
 * usage signal never sits on the request's critical path. Bounded (the id set
 * is the retrieval `limit`). Silently skips ids that have since been deleted.
 */
export const recordAccess = internalMutation({
	args: {
		ids: v.array(v.id('knowledgeEntries')),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		for (const id of args.ids) {
			const entry = await ctx.db.get(id);
			if (!entry) continue;
			await ctx.db.patch(id, {
				accessCount: (entry.accessCount ?? 0) + 1,
				lastAccessedAt: now,
			});
		}
	},
});

/**
 * Full-text leg of hybrid retrieval: the entry ids matching `queryText` over the
 * `search_knowledge` index, in relevance order. `ctx.vectorSearch` lives on the
 * action context and `withSearchIndex` on the query context, so the retrieval
 * action calls this to get the FTS ranking it fuses (via RRF) with its vector
 * ranking. Internal: scope/feature gating is the caller's job.
 */
export const ftsRankedIds = internalQuery({
	args: {
		queryText: v.string(),
		entryType: v.optional(entryTypeValidator),
		limit: v.number(),
	},
	handler: async (ctx, args): Promise<Id<'knowledgeEntries'>[]> => {
		const rows = await ctx.db
			.query('knowledgeEntries')
			.withSearchIndex('search_knowledge', (q) => {
				const sq = q.search('searchableText', args.queryText);
				return args.entryType ? sq.eq('entryType', args.entryType) : sq;
			})
			.take(args.limit);
		return rows.map((r) => r._id);
	},
});
