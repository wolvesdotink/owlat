import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	embeddingCohortValidator,
	embeddingCoverageFields,
	embeddingSlotValidator,
	embeddingSpaceIdentityFields,
	embeddingSpaceSourceValidator,
	embeddingSpaceStateValidator,
	embeddingTableValidator,
	reembedJobKindValidator,
	reembedJobStatusValidator,
	reembedPauseReasonValidator,
} from '../lib/validators/embedding';

/**
 * Embedding provenance (#1334).
 *
 * `knowledgeEntries` and `semanticFiles` stamp each vector with the space it
 * lives in (`embeddingSpaceId`) and where that came from (`embeddingProvenance`).
 * Retrieval filters vector search to the active space; a row with no space is
 * unknown and only lexical search finds it until the re-embed job stamps it.
 *
 * Cascade: a space is never deleted while a row references it (retire it
 * instead). Attestations and jobs reference spaces; rows reference spaces and
 * attestations. Workspace deletion sweeps rows first, then these tables.
 */
export const embeddingSpaceTables = {
	// One row per distinct space identity (`identityKey`,
	// lib/aiRouting/embeddingKeys.ts). At most one `active` and at most one
	// `staged`; `slot` says which vector column of the embedding tables holds
	// the space's vectors (`embedding` or `secondaryEmbedding`), so a staged
	// rebuild never overwrites the active vectors and activation is one patch.
	embeddingSpaces: defineTable({
		...embeddingSpaceIdentityFields,
		identityKey: v.string(),
		source: embeddingSpaceSourceValidator,
		state: embeddingSpaceStateValidator,
		slot: embeddingSlotValidator,
		/** `aiProviderConfig.embeddingModelVersion` when the space was registered. */
		configVersion: v.optional(v.number()),
		activatedAt: v.optional(v.number()),
		retiredAt: v.optional(v.number()),
		/**
		 * The space this one replaced when it was activated: the rollback target.
		 * Recorded at activation, never inferred from timestamps.
		 */
		predecessorSpaceId: v.optional(v.id('embeddingSpaces')),
		/**
		 * Raised every time this space takes its column (registered, activated,
		 * staged, attested, reused). The space with the highest claim in a column
		 * owns it; only the owner may write it, and stored vectors are reused only
		 * by their column's owner (lib/aiRouting/embeddingActivation.ts).
		 */
		columnClaim: v.optional(v.number()),
		/**
		 * Staged spaces: when an embedding input last changed or a row was added.
		 * Activation needs a rebuild pass that started after it.
		 */
		inputChangedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_identity_key', ['identityKey'])
		.index('by_state', ['state'])
		// A column's owner: the highest claim there (`readColumnOwner`).
		.index('by_slot_claim', ['slot', 'columnClaim']),

	// The evidence that assigns a legacy cohort to a space: an operator's
	// attestation (`attestation`, `attestedBy` set) or retained deployment or
	// configuration records (`record`). Recorded as what it is, never as measured
	// provenance; rows it assigns carry `embeddingProvenance` = this source and
	// `embeddingAttestationId` = this row. `cursor`/`phase` page the assignment.
	embeddingAttestations: defineTable({
		spaceId: v.id('embeddingSpaces'),
		source: v.union(v.literal('record'), v.literal('attestation')),
		cohort: embeddingCohortValidator,
		/** What was attested, or which records establish it. Admin-written, bounded. */
		statement: v.string(),
		attestedBy: v.optional(v.string()),
		attestedAt: v.number(),
		status: v.union(v.literal('applying'), v.literal('applied'), v.literal('revoked')),
		phase: v.optional(embeddingTableValidator),
		cursor: v.optional(v.string()),
		rowsAssigned: v.number(),
		revokedAt: v.optional(v.number()),
		revokedBy: v.optional(v.string()),
		updatedAt: v.number(),
	})
		.index('by_space', ['spaceId'])
		.index('by_status', ['status']),

	// The last completed coverage count (a singleton; `.first()`): how many rows
	// vector search can find in the searchable space, and how many wait as
	// unknown, inactive or unembedded. Counted by a bounded paged walk
	// (aiRouting/embeddingCoverage.ts), because Convex cannot count rows without
	// reading them. `searchableSpaceId` is the space the count was taken against
	// (absent: no space was searchable, so every vector counted as not found).
	embeddingCoverage: defineTable({
		...embeddingCoverageFields,
		searchableSpaceId: v.optional(v.id('embeddingSpaces')),
	}),

	// The re-embed walk. `reembed`: unknown and inactive-space rows into the
	// active space's column (local runs now; a paid one is admin-started and
	// admitted per batch under `rootRequestId`). `rebuild`: every row into a
	// staged space's column (Phase 5). One job runs at a time; `generation`
	// drops batches an earlier start scheduled.
	embeddingReembedJobs: defineTable({
		kind: reembedJobKindValidator,
		targetSpaceId: v.id('embeddingSpaces'),
		status: reembedJobStatusValidator,
		pausedReason: v.optional(reembedPauseReasonValidator),
		isPaid: v.boolean(),
		generation: v.number(),
		phase: embeddingTableValidator,
		cursor: v.optional(v.string()),
		scannedCount: v.number(),
		embeddedCount: v.number(),
		skippedCount: v.number(),
		failedCount: v.number(),
		startedBy: v.optional(v.string()),
		rootRequestId: v.optional(v.string()),
		startedAt: v.number(),
		updatedAt: v.number(),
		finishedAt: v.optional(v.number()),
		lastError: v.optional(v.string()),
	})
		.index('by_status', ['status'])
		.index('by_target_space', ['targetSpaceId']),
};
