/**
 * Knowledge Graph
 *
 * CRUD operations and search for typed knowledge entries.
 * Supports semantic search (vector), full-text search, and
 * contact-scoped retrieval.
 *
 * Every function of the graph is registered here, so callers address it as
 * `knowledge.graph.*`. The handlers that read or write `knowledgeRelations`
 * stay in this file, the relation seam `scripts/check-graph-scope.sh`
 * reviews; the other handlers live beside it: `entryReads.ts`,
 * `entryWrites.ts` and `policyEntries.ts`.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import type { Doc } from '../_generated/dataModel';
import { publicQuery } from '../lib/authedFunctions';
import { isSharedInboxReader } from '../inbox/access';
import {
	isKnowledgeEntryVisible,
	knowledgeAdminMutation,
	knowledgeMutation,
	loadWritableEntry,
	resolveKnowledgeViewer,
} from './visibility';
import { batchGet } from '../_utils/batchLoader';
import { throwInvalidInput } from '../_utils/errors';
import { relationTypeValidator } from '../schema/knowledge';
import { readOpenCommitments, type OpenCommitment } from './commitmentFacets';
import { syncEntryContacts } from './entryContacts';
import {
	ftsRankedIdsArgs,
	ftsRankedIdsHandler,
	getByContactArgs,
	getByContactHandler,
	getByIdsArgs,
	getByIdsHandler,
	listAllArgs,
	listAllHandler,
	listByTypeArgs,
	listByTypeHandler,
	searchArgs,
	searchHandler,
} from './entryReads';
import {
	createEntryArgs,
	createEntryHandler,
	recordAccessArgs,
	recordAccessHandler,
	requireCuratedWriter,
	saveEntryArgs,
	saveEntryHandler,
	setCommitmentStatusArgs,
	setCommitmentStatusHandler,
	updateEntryArgs,
	updateEntryHandler,
} from './entryWrites';
import {
	createPolicyEntryArgs,
	createPolicyEntryHandler,
	listPoliciesArgs,
	listPoliciesHandler,
} from './policyEntries';

// ============================================================
// Queries
// ============================================================

/**
 * Search knowledge entries by text query (full-text search)
 */
// authz: entryReads.searchHandler gates the read on resolveKnowledgeViewer.
export const search = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: searchArgs,
	handler: searchHandler,
});

/**
 * Get knowledge entries by type
 */
// authz: entryReads.listByTypeHandler gates the read on resolveKnowledgeViewer.
export const listByType = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: listByTypeArgs,
	handler: listByTypeHandler,
});

/**
 * List knowledge entries of every type, newest first. Powers the "All" tab,
 * which `listByType` can't serve — that query is keyed by a single `entryType`
 * (the `by_entry_type` index), so the UI fell back to 'fact' and the All tab
 * silently showed only facts.
 */
// authz: entryReads.listAllHandler gates the read on resolveKnowledgeViewer.
export const listAll = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: listAllArgs,
	handler: listAllHandler,
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
		const viewer = await resolveKnowledgeViewer(ctx);
		if (!viewer) return null;

		const entry = await ctx.db.get(args.entryId);
		if (!entry || !isKnowledgeEntryVisible(viewer.canReadInbox, entry)) return null;

		// Get outgoing relations
		const allOutgoing = await ctx.db
			.query('knowledgeRelations')
			.withIndex('by_from', (q) => q.eq('fromEntryId', args.entryId))
			.collect(); // bounded: one node's outgoing graph edges

		// Get incoming relations
		const allIncoming = await ctx.db
			.query('knowledgeRelations')
			.withIndex('by_to', (q) => q.eq('toEntryId', args.entryId))
			.collect(); // bounded: one node's incoming graph edges

		// Resolve the related entries' titles so the UI can render readable links
		// instead of raw Convex ids. A relation whose other end the caller may not
		// see is dropped with it, title and id alike.
		const relatedIds = [
			...allOutgoing.map((r) => r.toEntryId),
			...allIncoming.map((r) => r.fromEntryId),
		];
		const relatedDocs = await batchGet(ctx, relatedIds);
		const relatedEntries: Record<string, { title: string; entryType: string }> = {};
		const hidden = new Set<string>();
		for (const [id, doc] of relatedDocs) {
			// All ids came from knowledgeRelations, so every hit is a knowledgeEntry.
			const kdoc = doc as Doc<'knowledgeEntries'> | null;
			if (!kdoc) continue;
			if (isKnowledgeEntryVisible(viewer.canReadInbox, kdoc)) {
				relatedEntries[id] = { title: kdoc.title, entryType: kdoc.entryType };
			} else {
				hidden.add(id);
			}
		}
		const outgoing = allOutgoing.filter((r) => !hidden.has(r.toEntryId));
		const incoming = allIncoming.filter((r) => !hidden.has(r.fromEntryId));

		return { entry, outgoing, incoming, relatedEntries };
	},
});

/**
 * Get knowledge entries linked to a specific contact
 */
// authz: entryReads.getByContactHandler gates the read on resolveKnowledgeViewer.
export const getByContact = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: getByContactArgs,
	handler: getByContactHandler,
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
export const createEntry = knowledgeMutation({
	args: createEntryArgs,
	handler: createEntryHandler,
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
export const updateEntry = knowledgeMutation({
	args: updateEntryArgs,
	handler: updateEntryHandler,
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
export const deleteEntry = knowledgeMutation({
	args: {
		entryId: v.id('knowledgeEntries'),
	},
	handler: async (ctx, args, session) => {
		const entry = await loadWritableEntry(ctx, session, args.entryId);
		if (!entry) return null;
		requireCuratedWriter(session, entry);

		// Tear down the contact junction mirror first so no orphan rows survive.
		await syncEntryContacts(ctx, args.entryId, undefined);

		// Drain relations in both directions in capped pages. Looping until a page
		// comes back short guarantees we never leave the entry with dangling
		// relation rows — there is no other sweep that would reap them later.
		const RELATION_DELETE_PAGE = 500;
		const drainDirection = async (
			index: 'by_from' | 'by_to',
			field: 'fromEntryId' | 'toEntryId'
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
 * Save a knowledge entry from the agent pipeline (internal)
 */
export const saveEntry = internalMutation({
	args: saveEntryArgs,
	handler: saveEntryHandler,
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
export const addRelation = knowledgeMutation({
	args: {
		fromEntryId: v.id('knowledgeEntries'),
		toEntryId: v.id('knowledgeEntries'),
		relationType: relationTypeValidator,
	},
	handler: async (ctx, args, session) => {
		if (args.fromEntryId === args.toEntryId) {
			throwInvalidInput('A knowledge entry cannot be related to itself.');
		}

		const from = await loadWritableEntry(ctx, session, args.fromEntryId);
		const to = await loadWritableEntry(ctx, session, args.toEntryId);
		if (!from || !to) {
			throwInvalidInput('Both knowledge entries must exist to relate them.');
		}

		// De-dupe an identical edge (same direction + type) so re-clicking "Add"
		// doesn't accumulate duplicate rows the detail page would render twice.
		const existing = await ctx.db
			.query('knowledgeRelations')
			.withIndex('by_from', (q) => q.eq('fromEntryId', args.fromEntryId))
			.collect(); // bounded: outgoing relations for one entry (manually curated, small)
		const dup = existing.find(
			(r) => r.toEntryId === args.toEntryId && r.relationType === args.relationType
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
export const removeRelation = knowledgeMutation({
	args: {
		relationId: v.id('knowledgeRelations'),
	},
	handler: async (ctx, args, session) => {
		const relation = await ctx.db.get(args.relationId);
		if (!relation) return null;
		// A relation touching an entry the caller cannot see is treated as
		// missing. An endpoint that no longer exists hides nothing.
		const canReadInbox = isSharedInboxReader(session);
		for (const endpointId of [relation.fromEntryId, relation.toEntryId]) {
			const endpoint = await ctx.db.get(endpointId);
			if (endpoint && !isKnowledgeEntryVisible(canReadInbox, endpoint)) return null;
		}

		await ctx.db.delete(args.relationId);

		// Non-undefined success sentinel so the web `useBackendOperation` caller can
		// tell a void success from the `undefined` it returns on failure.
		return true;
	},
});

// ============================================================
// Curated policy / FAQ authoring surface
// ============================================================

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
// admin-only: a curated answer outranks every extracted fact and is quoted to customers
export const createPolicyEntry = knowledgeAdminMutation({
	args: createPolicyEntryArgs,
	handler: createPolicyEntryHandler,
});

/**
 * List curated canonical answers (policy / faq), newest first — the read side of
 * the FAQ authoring surface.
 */
// authz: policyEntries.listPoliciesHandler gates the read on resolveKnowledgeViewer.
export const listPolicies = publicQuery({
	// public: soft-auth — org members only; returns empty for anonymous/non-members
	args: listPoliciesArgs,
	handler: listPoliciesHandler,
});

/**
 * Set the lifecycle status of a commitment (`decision` / `action_item`) so a
 * fulfilled or cancelled promise stops surfacing in the open-commitments recall.
 * The human remedy for "we already delivered X" — without it a satisfied
 * commitment would keep leading the briefing until decay/expiry.
 */
// all-members: any org member can resolve a commitment; mirrors createEntry's write tier
export const setCommitmentStatus = knowledgeMutation({
	args: setCommitmentStatusArgs,
	handler: setCommitmentStatusHandler,
});

// ============================================================
// Internal Queries (for agent pipeline)
// ============================================================

/**
 * Fetch knowledge entries by a list of ids, preserving the input order.
 *
 * Used to hydrate the documents returned by a vector search: `ctx.vectorSearch`
 * (action-only) yields `{ _id, _score }` hits, and this query resolves them to
 * full documents. Entries that no longer exist are skipped. See
 * `knowledge/retrieval.ts:semanticSearch` for the action that calls this.
 */
export const getByIds = internalQuery({
	args: getByIdsArgs,
	handler: getByIdsHandler,
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
 * the contact, so no feature/membership gate here. Returns the entries without
 * their embeddings (`OpenCommitment`): the caller only reads title, content and
 * commitment metadata.
 */
export const getOpenCommitmentsByContact = internalQuery({
	args: {
		contactId: v.id('contacts'),
		limit: v.optional(v.number()),
		// Same contract as semanticSearch: Team Inbox-derived commitments are
		// returned only when the caller passes `true`.
		includeInboxDerived: v.boolean(),
	},
	handler: async (ctx, args): Promise<OpenCommitment[]> =>
		// Walks the contact's open-commitment junction rows in due order and loads
		// only the entries it returns (knowledge/commitmentFacets.ts).
		await readOpenCommitments(
			ctx,
			args.contactId,
			args.limit ?? 10,
			Date.now(),
			args.includeInboxDerived
		),
});

/**
 * Record a recall hit on the given entries: bump `accessCount` and stamp
 * `lastAccessedAt`. Scheduled fire-and-forget by knowledge.retrieval so the
 * usage signal never sits on the request's critical path. Bounded (the id set
 * is the retrieval `limit`). Silently skips ids that have since been deleted.
 */
export const recordAccess = internalMutation({
	args: recordAccessArgs,
	handler: recordAccessHandler,
});

/**
 * Full-text leg of hybrid retrieval: the entry ids matching `queryText` over the
 * `search_knowledge` index, in relevance order. `ctx.vectorSearch` lives on the
 * action context and `withSearchIndex` on the query context, so the retrieval
 * action calls this to get the FTS ranking it fuses (via RRF) with its vector
 * ranking. Internal: scope/feature gating is the caller's job.
 */
export const ftsRankedIds = internalQuery({
	args: ftsRankedIdsArgs,
	handler: ftsRankedIdsHandler,
});
