import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { literalUnion } from '../lib/literalUnion';
import { backfillJobStatusValidator } from '../lib/literalValidators';
import {
	embeddingProvenanceFields,
	embeddingSecondarySlotFields,
} from '../lib/validators/embedding';
import { knowledgeEntryCommitmentFacets } from './knowledgeCommitmentFacets';
import { semanticFileTables } from './semanticFiles';

/**
 * The knowledge entry types, as a literal tuple. Single source of truth for both
 * the Convex validator below and the zod enum the extraction pipeline feeds the
 * LLM (knowledge/extraction.ts) — deriving both from this tuple keeps them from
 * drifting.
 *
 * `policy` / `faq` are CURATED canonical answers (returns policy, pricing, hours,
 * standard terms). They are authored by a human through the FAQ surface
 * (knowledge/graph.ts:createPolicyEntry) with `isAuthoritative: true`, so retrieval
 * ranks them ahead of scraped facts (see lib/knowledgePrecedence.ts) — a policy
 * answer must not be outranked by a noisy scraped fact in the same RRF pool.
 */
export const ENTRY_TYPES = [
	'fact',
	'decision',
	'event',
	'preference',
	'goal',
	'relationship',
	'action_item',
	'policy',
	'faq',
] as const;

/**
 * The two commitment-bearing entry types: an `action_item` we owe a contact and a
 * `decision` we communicated. Single source of truth for the open-commitments
 * recall (knowledge/graph.ts:getOpenCommitmentsByContact) so a promise ("we'll
 * ship X by Friday") is surfaced by contact scope INDEPENDENTLY of whether the
 * new inbound restates it — semantic similarity would only recall it when the
 * email mentions it, which is exactly when it is least needed.
 */
export const COMMITMENT_ENTRY_TYPES = ['decision', 'action_item'] as const;

/**
 * The two curated canonical entry types (see ENTRY_TYPES). Single source of truth
 * for the policy authoring surface and the briefing's first-class policy section.
 */
export const POLICY_ENTRY_TYPES = ['policy', 'faq'] as const;

/**
 * Lifecycle of a commitment (`decision` / `action_item`). A missing value is
 * treated as `open` (durable commitments authored before the field existed, and
 * fresh extractions that don't set it, stay recallable until a human resolves
 * them). Only `fulfilled` / `cancelled` drop a commitment out of the open-recall.
 */
const COMMITMENT_STATUSES = ['open', 'fulfilled', 'cancelled'] as const;

/**
 * Validator for `knowledgeEntries.commitmentStatus`, derived from
 * `COMMITMENT_STATUSES`.
 */
export const commitmentStatusValidator = literalUnion(COMMITMENT_STATUSES);

/**
 * Whether a commitment is still open (undefined ⇒ open — see COMMITMENT_STATUSES).
 * Pure helper shared by the recall query and its tests.
 */
export function isCommitmentOpen(
	status: (typeof COMMITMENT_STATUSES)[number] | undefined
): boolean {
	return status !== 'fulfilled' && status !== 'cancelled';
}

/**
 * The nine knowledge entry types. Exported so retrieval/extraction code can
 * validate `entryType` args against the same source of truth as the table.
 */
export const entryTypeValidator = literalUnion(ENTRY_TYPES);

/**
 * The five knowledge source types (knowledgeEntries.sourceType). Exported so
 * the graph mutations and the extraction idempotency probe validate against the
 * same source of truth as the table column.
 */
export const sourceTypeValidator = v.union(
	v.literal('email'),
	v.literal('chat'),
	v.literal('manual'),
	v.literal('file'),
	v.literal('agent_extracted'),
	// A human-curated canonical answer authored through the FAQ surface. Kept
	// distinct from `manual` so curated policy/FAQ can be listed/managed on its
	// own and so the isAuthoritative flag has an unambiguous origin.
	v.literal('curated')
);

/**
 * The six typed-edge kinds a relation between two knowledge entries can have, as
 * a literal tuple. Single source of truth for the `knowledgeRelations` column
 * validator below and for the graph mutations that author/validate relations,
 * so the relation-authoring UI's options can't drift from the stored column.
 */
export const RELATION_TYPES = [
	'supports',
	'contradicts',
	'supersedes',
	'relates_to',
	'causes',
	'blocks',
] as const;

/**
 * Validator for `knowledgeRelations.relationType`, derived from `RELATION_TYPES`.
 */
export const relationTypeValidator = literalUnion(RELATION_TYPES);

/**
 * How sure we are an edge is real, as a literal tuple. Single source of truth for
 * the `knowledgeRelations.confidenceTag` column validator and the pure edge
 * helpers in `lib/knowledgeEdges.ts` (tagRank / tagForInferredConfidence). The
 * tag is a coarse, sortable companion to the numeric `confidence`:
 *   - `extracted`  — stated directly in a source (or authored by a human).
 *   - `inferred`   — derived with high enough confidence to trust.
 *   - `ambiguous`  — derived but below the inference floor; surfaced cautiously.
 */
export const EDGE_CONFIDENCE_TAGS = ['extracted', 'inferred', 'ambiguous'] as const;

/**
 * Validator for `knowledgeRelations.confidenceTag`, derived from
 * `EDGE_CONFIDENCE_TAGS`.
 */
export const edgeConfidenceTagValidator = literalUnion(EDGE_CONFIDENCE_TAGS);

/**
 * Where an edge came from, as a literal tuple. Single source of truth for the
 * `knowledgeRelations.provenance` column validator and the pure edge helpers in
 * `lib/knowledgeEdges.ts` (provenanceRank). Strength order (strongest first):
 * `manual` (a human authored it) > `deterministic` (a rule-based linker) >
 * `llm` (an LLM inferred it). Merging two edges keeps the strongest provenance.
 */
export const EDGE_PROVENANCES = ['deterministic', 'llm', 'manual'] as const;

/**
 * Validator for `knowledgeRelations.provenance`, derived from `EDGE_PROVENANCES`.
 */
const edgeProvenanceValidator = literalUnion(EDGE_PROVENANCES);

/** Field record of `knowledgeEntries`, shared with the functions that write it. */
export const knowledgeEntriesFields = {
	entryType: entryTypeValidator,
	title: v.string(),
	content: v.string(),
	// Source attribution
	sourceType: sourceTypeValidator,
	sourceId: v.optional(v.string()), // ID of the source message/file
	// The source type a curated answer was made from: `curated` when it was
	// authored as one, else the `sourceType` the entry had before
	// `knowledge.graph.createPolicyEntry` rewrote it to `curated` (kept through
	// later edits). Absent on a curated answer written before this field: its
	// earlier source is unknown, so it cannot be shared with members
	// (knowledge/sharing.ts). Never set by a client.
	curatedFromSourceType: v.optional(sourceTypeValidator),
	// Entity links
	contactIds: v.optional(v.array(v.id('contacts'))),
	threadId: v.optional(v.id('conversationThreads')),
	// Whether members may see what was learned here (inbox/access.ts
	// `isInboxDerivedKnowledge`). `restricted` keeps it to shared-inbox readers
	// whatever the source; for `sourceType: 'file'` only `members` opens it.
	// Every write of this release stamps it, from the source (knowledge/
	// entryDedupe.ts `resolveMemberAccess`), so ABSENT means a row written before
	// this release: the dedup leaves those alone (knowledge/maintenance.ts) until
	// migration 0069 restricts them, and never reopens one. A merge never widens
	// it. Never set by a client, except an owner or admin sharing a reviewed
	// entry with members (knowledge/sharing.ts).
	memberAccess: v.optional(v.union(v.literal('members'), v.literal('restricted'))),
	// Vector embedding for semantic search (1536 dimensions for text-embedding-3-small)
	embedding: v.array(v.float64()),
	// Model that produced `embedding` (e.g., 'text-embedding-3-small'). Re-embed when this changes.
	embeddingModel: v.optional(v.string()),
	// When `embedding` was generated; used to schedule re-embedding on stale entries.
	embeddingGeneratedAt: v.optional(v.number()),
	// Embedding provenance (ADR-0073): the space `embedding` lives in and where
	// that assignment came from. Absent space ⇒ unknown: vector search excludes
	// the entry until the re-embed job stamps it; full-text search still finds it.
	...embeddingProvenanceFields,
	// Phase 5's staged-rebuild column (lib/validators/embedding.ts).
	...embeddingSecondarySlotFields,
	// Vector filters cannot AND two fields, so the space-and-type filter reads
	// one composite key per column: `embeddingSpaceEntryKey(spaceId, entryType)`
	// (lib/aiRouting/embeddingKeys.ts). Written with the space id.
	embeddingSpaceEntryKey: v.optional(v.string()),
	secondaryEmbeddingSpaceEntryKey: v.optional(v.string()),
	// Confidence and maintenance
	confidence: v.number(), // 0-1
	lastValidatedAt: v.number(),
	expiresAt: v.optional(v.number()),
	// Curated-canonical marker. Set true only on human-authored `policy` / `faq`
	// entries (sourceType 'curated'); retrieval ranks these ahead of scraped
	// facts in the same RRF pool (lib/knowledgePrecedence.ts) so a canonical
	// answer can't be outranked by noise. A newer scraped fact that SUPERSEDES
	// the policy (a `supersedes` edge → `_stale`) still wins — precedence never
	// promotes a superseded entry. Optional/absent ⇒ an ordinary (scraped) fact.
	// Named with the required is* prefix per the boolean-naming ratchet.
	isAuthoritative: v.optional(v.boolean()),
	// Commitment lifecycle for `decision` / `action_item` entries. `dueAt` is the
	// promised-by time (if any); `commitmentStatus` drives the contact-scoped
	// open-commitments recall (undefined ⇒ open — see isCommitmentOpen). Absent
	// on non-commitment entries and on commitments authored before the field.
	commitmentStatus: v.optional(commitmentStatusValidator),
	dueAt: v.optional(v.number()),
	// Usage signal: how often / how recently this entry has been retrieved.
	// Bumped fire-and-forget by knowledge.retrieval on every recall hit and
	// read by the decay cron's access boost (frequently-grounded facts decay
	// slower, never-recalled ones fade faster). Optional — absent on entries
	// written before the field existed; the decay falls back to createdAt.
	accessCount: v.optional(v.number()),
	lastAccessedAt: v.optional(v.number()),
	// Search and categorization
	tags: v.optional(v.array(v.string())),
	searchableText: v.optional(v.string()),
	// Deterministic content fingerprint (sha256 of normalizeForHash(title, content),
	// computed by the 'use node' extraction action). Lets the deterministic linker
	// and dedup probe find entries with byte-identical normalized content via the
	// `by_content_hash` index instead of scanning. Optional — absent on entries
	// written before the field existed and on manual entries that skip hashing.
	contentHash: v.optional(v.string()),
	// Timestamps
	createdAt: v.number(),
	updatedAt: v.number(),
};

/**
 * Knowledge graph + semantic file tables — typed knowledge extracted from communications,
 * relationships between knowledge entries, and embedded file storage.
 *
 * Spread into `defineSchema()` from schema.ts via `...knowledgeTables`.
 */
export const knowledgeTables = {
	// Knowledge Entries - typed organizational knowledge extracted from communications
	knowledgeEntries: defineTable(knowledgeEntriesFields)
		.index('by_entry_type', ['entryType'])
		.index('by_created_at', ['createdAt'])
		.index('by_thread', ['threadId'])
		.index('by_source', ['sourceType', 'sourceId'])
		.index('by_content_hash', ['contentHash'])
		// The re-embed job's walk over unknown (absent) and inactive-space rows,
		// and an attestation's cohort by the time its vectors were written.
		.index('by_embedding_space', ['embeddingSpaceId', 'embeddingGeneratedAt'])
		.index('by_secondary_embedding_space', ['secondaryEmbeddingSpaceId'])
		// SEALED-AT-REST EXCEPTION (Sealed Mail E8b): message bodies are sealed with
		// the instance data key, but `searchableText` (the full-text search field
		// derived from body/knowledge text) and `embedding` (the vector derived from
		// plaintext at ingest) stay PLAINTEXT-DERIVED — Convex indexes plaintext, so
		// sealing them would break server-side search and semantic retrieval. This is
		// the documented, deliberate exception. See lib/atRestBodies.ts and
		// apps/docs/content/en/3.developer/21.sealed-mail-at-rest.md.
		.searchIndex('search_knowledge', {
			searchField: 'searchableText',
			filterFields: ['entryType'],
		})
		.vectorIndex('vector_knowledge', {
			vectorField: 'embedding',
			dimensions: 1536,
			filterFields: ['entryType', 'embeddingSpaceId', 'embeddingSpaceEntryKey'],
		})
		.vectorIndex('vector_knowledge_secondary', {
			vectorField: 'secondaryEmbedding',
			dimensions: 1536,
			filterFields: ['secondaryEmbeddingSpaceId', 'secondaryEmbeddingSpaceEntryKey'],
		}),

	// Knowledge Entry ↔ Contact junction — an index-able mirror of
	// `knowledgeEntries.contactIds` (which is an array Convex can't index).
	// One row per (entryId, contactId) pair; written/cleaned by the same
	// mutations that set/clear `contactIds`. `getByContact` queries `by_contact`
	// instead of scanning the newest entries and filtering in JS, so it stays
	// complete and O(matches) past the old 500-row truncation. Repointed on
	// contact merge (lib/contactMutations.ts) and torn down with the parent
	// entry on expiry/delete/org-wipe.
	knowledgeEntryContacts: defineTable({
		entryId: v.id('knowledgeEntries'),
		contactId: v.id('contacts'),
		...knowledgeEntryCommitmentFacets, // open-commitment index keys (#919)
	})
		.index('by_contact', ['contactId'])
		.index('by_entry', ['entryId'])
		.index('by_contact_open_commitment', [
			'contactId',
			'isOpenCommitment',
			'commitmentDueKey',
			'commitmentOrderKey',
		]),

	// Knowledge Relations - typed edges between knowledge entries.
	//
	// Edges carry their own evidence so retrieval and analytics can weigh them:
	//   - confidenceTag / confidence — how sure we are the edge is real (coarse
	//     sortable tag + the underlying 0-1 score).
	//   - provenance — who authored it (manual > deterministic > llm); the merge
	//     rule in lib/knowledgeEdges.ts keeps the strongest.
	//   - weight — optional edge strength used by graph-augmented retrieval /
	//     analytics to rank traversals; absent until a linker assigns one.
	//   - rationale — optional human/LLM explanation of why the edge exists.
	// NB: edges have NO contact scope. A dedup-merge unions contactIds, so an edge
	// can join a contact-A node to a contact-B-only node — every traversal at
	// retrieval MUST re-check the neighbor with isContactScopeVisible.
	knowledgeRelations: defineTable({
		fromEntryId: v.id('knowledgeEntries'),
		toEntryId: v.id('knowledgeEntries'),
		relationType: relationTypeValidator,
		confidenceTag: edgeConfidenceTagValidator,
		confidence: v.number(), // 0-1
		weight: v.optional(v.number()),
		provenance: edgeProvenanceValidator,
		rationale: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_from', ['fromEntryId'])
		.index('by_to', ['toEntryId'])
		.index('by_pair', ['fromEntryId', 'toEntryId'])
		.index('by_confidence_tag', ['confidenceTag']),

	...semanticFileTables,

	// Knowledge Edge Backfill Jobs — tracks the one-shot pass that populates
	// LLM-inferred edges over the EXISTING (sparse) knowledge corpus when
	// `ai.knowledge.autoLink` is first enabled. The deterministic + LLM linkers
	// only fire on fresh ingestion, so without this retroactive walk graph
	// retrieval would have nothing to traverse until new mail arrives.
	//
	// Created when the autoLink toggle flips false→true and no prior job exists
	// (first-run gate, mirroring `knowledgeBackfillJobs` and its walker
	// `knowledge/messageBackfill.ts`; shared lifecycle in
	// `knowledge/backfillJobs.ts`). Kept in its OWN table so the gate is
	// independent of the agent message-extraction backfill.
	// `knowledge.edgeBackfill.runEdgeBackfill` walks `knowledgeEntries` by cursor,
	// scheduling one `edgeInference.inferRelations` action per entry; the job is
	// idempotent (re-runs merge via upsertEdge) and admin-cancellable mid-walk.
	// A walk that stops making progress is marked 'failed' by the daily
	// stale-job sweep (`knowledge.maintenance.failStaleBackfillJobs`).
	knowledgeEdgeBackfillJobs: defineTable({
		status: backfillJobStatusValidator,
		triggeredBy: v.string(), // identity.subject of the admin who enabled the flag
		// Capped count of existing entries at start — the progress-bar denominator.
		totalCount: v.number(),
		// Entries paged through, and inference actions scheduled, so far.
		scannedCount: v.number(),
		scheduledCount: v.number(),
		// Resumable pagination cursor over knowledgeEntries (Convex continueCursor).
		cursor: v.optional(v.string()),
		startedAt: v.number(),
		updatedAt: v.number(),
		finishedAt: v.optional(v.number()),
		errorMessage: v.optional(v.string()),
	})
		.index('by_status', ['status'])
		.index('by_started_at', ['startedAt']),

	// Knowledge Graph Analytics — a SINGLE cron-cached snapshot of the whole
	// knowledge graph's shape (graphify's "insight layer"), recomputed every 24h
	// by `knowledge.graphAnalytics.recomputeStats` and read by the member-only
	// analytics dashboard. Gated on `ai.knowledge.analytics` (default off).
	//
	// One row, found/replaced via `by_kind` (the `kind` discriminator is a fixed
	// literal). Every array is hard-capped so the row stays well under Convex's
	// ~1 MiB document limit even on a large graph; `truncated` records when the
	// node/edge scan hit its cap and the figures are therefore approximate.
	//
	// SECURITY / REDACTION: this snapshot is member-trusted (org-wide) and NEVER
	// feeds any AI/retrieval path. `surprisingConnections` is REDACTED — it
	// excludes cross-contact-disjoint edges (an edge whose two endpoints are each
	// scoped to different contacts with no shared contact and neither org-general),
	// since surfacing one would bridge contact A → contact B in the UI. Those edges
	// are summarized only as the aggregate `crossContactLinkCount`; their details
	// live in `crossContactLinks`, which the member read (`getGraphStats`) strips
	// and no public dashboard query returns.
	knowledgeGraphStats: defineTable({
		// Fixed discriminator for the singleton snapshot row (by_kind find-or-replace).
		kind: v.literal('graph'),
		// When the snapshot was computed (action wall-clock).
		computedAt: v.number(),
		// Graph size over the scanned (possibly capped) node/edge set.
		nodeCount: v.number(),
		edgeCount: v.number(),
		// True when the node or edge cap was hit — the figures are approximate.
		isTruncated: v.boolean(),
		// "God nodes" — the highest-degree hubs (cap 50, degree-descending).
		godNodes: v.array(
			v.object({
				entryId: v.id('knowledgeEntries'),
				title: v.string(),
				entryType: entryTypeValidator,
				degree: v.number(),
				inDegree: v.number(),
				outDegree: v.number(),
			})
		),
		// Node-confidence distribution: 10 bucket counts over [0,1] (sum === nodeCount),
		// plus mean/median and the count below the review threshold.
		confidenceBuckets: v.array(v.number()),
		confidenceMean: v.number(),
		confidenceMedian: v.number(),
		belowReviewThreshold: v.number(),
		// Approximate communities (label propagation): how many, and their sizes
		// (cap 20, size-descending).
		communityCount: v.number(),
		communitySizes: v.array(v.number()),
		// Most "surprising" connections (cap 50, score-descending) — REDACTED:
		// cross-contact-disjoint edges are excluded (see header).
		surprisingConnections: v.array(
			v.object({
				fromEntryId: v.id('knowledgeEntries'),
				toEntryId: v.id('knowledgeEntries'),
				fromTitle: v.string(),
				toTitle: v.string(),
				relationType: relationTypeValidator,
				score: v.number(),
			})
		),
		// Aggregate count of cross-contact-disjoint edges in the scanned graph (the
		// member-visible summary of the redacted set).
		crossContactLinkCount: v.number(),
		// ADMIN-ONLY detail of the redacted cross-contact-disjoint edges (cap 50).
		// Stripped from the member read; retained for recompute/audit evolution.
		crossContactLinks: v.array(
			v.object({
				fromEntryId: v.id('knowledgeEntries'),
				toEntryId: v.id('knowledgeEntries'),
				fromTitle: v.string(),
				toTitle: v.string(),
				relationType: relationTypeValidator,
				score: v.number(),
			})
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_kind', ['kind']),
};
