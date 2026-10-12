/**
 * Validators for embedding provenance (ADR-0073, Phase 1a and Phase 5): the
 * space identity, the provenance stamp on `knowledgeEntries` and
 * `semanticFiles`, the cohort attestation and the re-embed job. Vocabularies
 * come from `@owlat/shared/aiRouting`. A leaf module: the schema loads it.
 */

import { v } from 'convex/values';
import {
	EMBEDDING_PROVENANCE_SOURCES,
	EMBEDDING_SPACE_STATES,
	REEMBED_JOB_KINDS,
	REEMBED_JOB_STATUSES,
	REEMBED_PAUSE_REASONS,
} from '@owlat/shared/aiRouting';
import { literalUnion } from '../literalUnion';
import { embeddingProviderKindValidator } from './aiProviderConfig';

export const embeddingProvenanceSourceValidator = literalUnion(EMBEDDING_PROVENANCE_SOURCES);
export const embeddingSpaceStateValidator = literalUnion(EMBEDDING_SPACE_STATES);
export const reembedJobKindValidator = literalUnion(REEMBED_JOB_KINDS);
export const reembedJobStatusValidator = literalUnion(REEMBED_JOB_STATUSES);
export const reembedPauseReasonValidator = literalUnion(REEMBED_PAUSE_REASONS);

/**
 * Where a space's identity was learned. `stored_config` / `env`: resolved from
 * the live configuration when the space was registered. `record`: retained
 * deployment or configuration records establish it for a past period.
 * `attestation`: an operator attested to it. Only the first two are measured.
 */
export const EMBEDDING_SPACE_SOURCES = ['stored_config', 'env', 'record', 'attestation'] as const;
export const embeddingSpaceSourceValidator = literalUnion(EMBEDDING_SPACE_SOURCES);

/** The two vector columns of an embedding-bearing row (see `embeddingSlotFields`). */
export const EMBEDDING_SLOTS = ['primary', 'secondary'] as const;
export const embeddingSlotValidator = literalUnion(EMBEDDING_SLOTS);

/** The tables whose rows carry embeddings, as an attestation's cohort names them. */
export const EMBEDDING_TABLES = ['knowledgeEntries', 'semanticFiles'] as const;
export const embeddingTableValidator = literalUnion(EMBEDDING_TABLES);

/**
 * What makes two vectors comparable: provider kind, the secret-free endpoint
 * identity, model, native dimensions and revision. For local models the
 * revision is the resolved artifact digest plus quantization (`nomic-embed-text`
 * is an unversioned alias). Two spaces with the same identity are one space.
 */
export const embeddingSpaceIdentityFields = {
	provider: embeddingProviderKindValidator,
	/** Secret-free endpoint identity: `native`, or the origin of a custom base URL. Never a key. */
	endpoint: v.string(),
	model: v.string(),
	/** The model's native output width, before `toIndexVector` pads to the index. */
	dimensions: v.number(),
	/** Provider revision or artifact digest. Absent when the provider exposes none. */
	revision: v.optional(v.string()),
	/** Local models: the quantization the digest was served at (`q4_K_M`, `f16`, …). */
	quantization: v.optional(v.string()),
};

/**
 * The provenance stamp on an embedding-bearing row, for its primary vector
 * (`embedding`). Absent `embeddingSpaceId` ⇒ unknown: vector search excludes the
 * row, lexical search still finds it, and the re-embed job brings it back.
 */
export const embeddingProvenanceFields = {
	embeddingSpaceId: v.optional(v.id('embeddingSpaces')),
	embeddingProvenance: v.optional(embeddingProvenanceSourceValidator),
	/** Set when `embeddingProvenance` is `record` or `attestation`: the evidence row. */
	embeddingAttestationId: v.optional(v.id('embeddingAttestations')),
};

/**
 * The second vector column, for the Phase 5 staged rebuild. A rebuild writes the
 * new space here while retrieval keeps reading the active one; activation flips
 * which space is active (one row, atomically) and rollback flips it back. Each
 * column has its own vector index, and a space records which column it lives in
 * (`embeddingSpaces.slot`).
 */
export const embeddingSecondarySlotFields = {
	secondaryEmbedding: v.optional(v.array(v.float64())),
	secondaryEmbeddingSpaceId: v.optional(v.id('embeddingSpaces')),
	secondaryEmbeddingGeneratedAt: v.optional(v.number()),
};

/** The cohort an attestation (or a deployment record) assigns to a space. */
export const embeddingCohortValidator = v.object({
	tables: v.array(embeddingTableValidator),
	/** Inclusive start of the period the vectors were written in; absent ⇒ since the beginning. */
	writtenFrom: v.optional(v.number()),
	/** Exclusive end of that period. Rows embedded later are not in the cohort. */
	writtenUntil: v.number(),
	/** The legacy `embeddingModel` stamp the cohort's rows carry, if the cohort is narrowed by it. */
	legacyModelStamp: v.optional(v.string()),
});

/** One table's vectors by where they stand against the active space. */
const embeddingCoverageCountsValidator = v.object({
	/** A vector in the active space: vector search finds the row. */
	active: v.number(),
	/** A vector with no recorded space (written before provenance): lexical search only. */
	unknown: v.number(),
	/** A vector in another space only: lexical search until re-embedded. */
	inactive: v.number(),
	/** No vector at all (pending, too little text, or a dropped stale vector). */
	unembedded: v.number(),
});

/**
 * The last completed coverage count of the active space (`embeddingSpaces.coverage`),
 * from a bounded paged walk (`aiRouting/embeddingCoverage.ts`): Convex cannot count
 * rows without reading them, so the settings page reads this snapshot.
 */
export const embeddingCoverageValidator = v.object({
	knowledgeEntries: embeddingCoverageCountsValidator,
	semanticFiles: embeddingCoverageCountsValidator,
	measuredAt: v.number(),
});

/**
 * A space as a job measured it (`lib/aiRouting/embeddingProbe.ts`): the
 * identity plus where its target came from. Commit mutations and searches take
 * it beside a vector, so the vector is stamped or filtered by its real space.
 */
export const measuredEmbeddingSpaceValidator = v.object({
	...embeddingSpaceIdentityFields,
	source: v.union(v.literal('stored_config'), v.literal('env')),
});
