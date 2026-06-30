import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * The seven knowledge entry types, as a literal tuple. Single source of truth
 * for both the Convex validator below and the zod enum the extraction pipeline
 * feeds the LLM (knowledge/extraction.ts) — deriving both from this tuple keeps
 * them from drifting.
 */
export const ENTRY_TYPES = [
	'fact',
	'decision',
	'event',
	'preference',
	'goal',
	'relationship',
	'action_item',
] as const;

/**
 * The seven knowledge entry types. Exported so retrieval/extraction code can
 * validate `entryType` args against the same source of truth as the table.
 */
export const entryTypeValidator = v.union(
	...ENTRY_TYPES.map((t) => v.literal(t)),
);

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
	v.literal('agent_extracted')
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
export const relationTypeValidator = v.union(
	...RELATION_TYPES.map((t) => v.literal(t)),
);

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
export const edgeConfidenceTagValidator = v.union(
	...EDGE_CONFIDENCE_TAGS.map((t) => v.literal(t)),
);

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
export const edgeProvenanceValidator = v.union(
	...EDGE_PROVENANCES.map((p) => v.literal(p)),
);

/**
 * Knowledge graph + semantic file tables — typed knowledge extracted from communications,
 * relationships between knowledge entries, and embedded file storage.
 *
 * Spread into `defineSchema()` from schema.ts via `...knowledgeTables`.
 */
export const knowledgeTables = {
	// Knowledge Entries - typed organizational knowledge extracted from communications
	knowledgeEntries: defineTable({
		entryType: entryTypeValidator,
		title: v.string(),
		content: v.string(),
		// Source attribution
		sourceType: sourceTypeValidator,
		sourceId: v.optional(v.string()), // ID of the source message/file
		// Entity links
		contactIds: v.optional(v.array(v.id('contacts'))),
		threadId: v.optional(v.id('conversationThreads')),
		// Vector embedding for semantic search (1536 dimensions for text-embedding-3-small)
		embedding: v.array(v.float64()),
		// Model that produced `embedding` (e.g., 'text-embedding-3-small'). Re-embed when this changes.
		embeddingModel: v.optional(v.string()),
		// When `embedding` was generated; used to schedule re-embedding on stale entries.
		embeddingGeneratedAt: v.optional(v.number()),
		// Confidence and maintenance
		confidence: v.number(), // 0-1
		lastValidatedAt: v.number(),
		expiresAt: v.optional(v.number()),
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
	})
		.index('by_entry_type', ['entryType'])
		.index('by_created_at', ['createdAt'])
		.index('by_thread', ['threadId'])
		.index('by_source', ['sourceType', 'sourceId'])
		.index('by_content_hash', ['contentHash'])
		.searchIndex('search_knowledge', {
			searchField: 'searchableText',
			filterFields: ['entryType'],
		})
		.vectorIndex('vector_knowledge', {
			vectorField: 'embedding',
			dimensions: 1536,
			filterFields: ['entryType'],
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
	})
		.index('by_contact', ['contactId'])
		.index('by_entry', ['entryId']),

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

	// Semantic Files - files with embeddings, auto-tags, and version tracking
	semanticFiles: defineTable({
		storageId: v.id('_storage'),
		filename: v.string(),
		mimeType: v.string(),
		fileSize: v.number(),
		// Semantic metadata
		title: v.optional(v.string()),
		summary: v.optional(v.string()),
		extractedText: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		autoTags: v.optional(v.array(v.string())),
		// Provenance
		sourceType: v.union(
			v.literal('upload'),
			v.literal('email_attachment'),
			v.literal('agent_generated')
		),
		sourceMessageId: v.optional(v.string()),
		uploadedBy: v.optional(v.string()),
		// Provenance: why/where this version was shared. JSON-stringified
		// { senderName?, excerpt?, threadSubject?, timestamp? } captured from the
		// surrounding conversation at upload time.
		uploadContext: v.optional(v.string()),
		// Relationships
		contactIds: v.optional(v.array(v.id('contacts'))),
		threadId: v.optional(v.id('conversationThreads')),
		// Versioning
		version: v.number(),
		previousVersionId: v.optional(v.id('semanticFiles')),
		// Human-readable diff vs the previous version (text-based files only),
		// e.g. "≈3 paragraphs changed". Computed by the processing pipeline.
		changeSummary: v.optional(v.string()),
		// Vector embedding for semantic search
		embedding: v.array(v.float64()),
		// Model that produced `embedding` (e.g., 'text-embedding-3-small'). Re-embed when this changes.
		embeddingModel: v.optional(v.string()),
		// When `embedding` was generated; used to schedule re-embedding on stale entries.
		embeddingGeneratedAt: v.optional(v.number()),
		// Full-text search
		searchableText: v.optional(v.string()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_created_at', ['createdAt'])
		.index('by_thread', ['threadId'])
		.index('by_previous_version', ['previousVersionId'])
		.searchIndex('search_files', {
			searchField: 'searchableText',
			filterFields: [],
		})
		.vectorIndex('vector_files', {
			vectorField: 'embedding',
			dimensions: 1536,
			filterFields: [],
		}),

	// Semantic file ↔ Contact junction — an index-able mirror of
	// `semanticFiles.contactIds` (an array Convex can't index). One row per
	// (fileId, contactId); written/cleaned by the same mutations that set/clear
	// `contactIds` (syncFileContacts). `listByContact` queries `by_contact`
	// instead of scanning the newest 200 files and filtering the array in JS, so
	// it stays complete (no silent truncation past 200) and O(matches). Repointed
	// on contact merge (lib/contactMutations.ts) and torn down with the parent
	// file on delete / org-wipe. Mirrors `knowledgeEntryContacts`.
	semanticFileContacts: defineTable({
		fileId: v.id('semanticFiles'),
		contactId: v.id('contacts'),
	})
		.index('by_contact', ['contactId'])
		.index('by_file', ['fileId']),

	// Knowledge Edge Backfill Jobs — tracks the one-shot pass that populates
	// LLM-inferred edges over the EXISTING (sparse) knowledge corpus when
	// `ai.knowledge.autoLink` is first enabled. The deterministic + LLM linkers
	// only fire on fresh ingestion, so without this retroactive walk graph
	// retrieval would have nothing to traverse until new mail arrives.
	//
	// Created when the autoLink toggle flips false→true and no prior job exists
	// (first-run gate, mirroring `knowledgeBackfillJobs`). Kept in its OWN table
	// so the gate is independent of the agent message-extraction backfill.
	// `knowledge.edgeBackfill.runEdgeBackfill` walks `knowledgeEntries` by cursor,
	// scheduling one `edgeInference.inferRelations` action per entry; the job is
	// idempotent (re-runs merge via upsertEdge) and admin-cancellable mid-walk.
	knowledgeEdgeBackfillJobs: defineTable({
		status: v.union(
			v.literal('pending'),
			v.literal('running'),
			v.literal('completed'),
			v.literal('cancelled'),
			v.literal('failed')
		),
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
	// and only the role-gated `getCrossContactLinks` adminQuery returns.
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
			}),
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
			}),
		),
		// Aggregate count of cross-contact-disjoint edges in the scanned graph (the
		// member-visible summary of the redacted set).
		crossContactLinkCount: v.number(),
		// ADMIN-ONLY detail of the redacted cross-contact-disjoint edges (cap 50).
		// Stripped from the member read; surfaced only by `getCrossContactLinks`.
		crossContactLinks: v.array(
			v.object({
				fromEntryId: v.id('knowledgeEntries'),
				toEntryId: v.id('knowledgeEntries'),
				fromTitle: v.string(),
				toTitle: v.string(),
				relationType: relationTypeValidator,
				score: v.number(),
			}),
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_kind', ['kind']),
};
