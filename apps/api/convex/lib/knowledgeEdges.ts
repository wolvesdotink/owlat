/**
 * Knowledge-graph edge helpers — pure, ctx-free logic shared by the edge
 * authoring/merge paths and the analytics layer.
 *
 * Everything here is deterministic and dependency-free (no Convex `ctx`, no I/O)
 * so it can be unit-tested in isolation and called from both `'use node'`
 * actions and ordinary mutations. The one thing that genuinely needs Node — the
 * sha256 of `normalizeForHash(...)` — is computed by the caller in a
 * `'use node'` action (`crypto`); this module only produces the canonical string
 * that gets hashed, so it stays runtime-agnostic.
 */

import { EDGE_CONFIDENCE_TAGS, EDGE_PROVENANCES } from '../schema/knowledge';

/** How sure we are an edge is real. Derived from the schema's single source. */
export type EdgeConfidenceTag = (typeof EDGE_CONFIDENCE_TAGS)[number];

/** Where an edge came from. Derived from the schema's single source. */
export type EdgeProvenance = (typeof EDGE_PROVENANCES)[number];

/**
 * Strength rank for a confidence tag (higher = stronger): extracted > inferred >
 * ambiguous. Used to pick the stronger tag when two edges merge and to sort
 * edges by trustworthiness.
 */
const TAG_RANK: Record<EdgeConfidenceTag, number> = {
	extracted: 2,
	inferred: 1,
	ambiguous: 0,
};

/** Strength rank for a confidence tag (extracted > inferred > ambiguous). */
export function tagRank(tag: EdgeConfidenceTag): number {
	return TAG_RANK[tag];
}

/**
 * Strength rank for a provenance (higher = stronger): manual > deterministic >
 * llm. A human-authored edge always wins over a rule-derived one, which wins
 * over an LLM-inferred one.
 */
const PROVENANCE_RANK: Record<EdgeProvenance, number> = {
	manual: 2,
	deterministic: 1,
	llm: 0,
};

/** Strength rank for a provenance (manual > deterministic > llm). */
export function provenanceRank(provenance: EdgeProvenance): number {
	return PROVENANCE_RANK[provenance];
}

/**
 * The mutable attributes an edge carries beyond its endpoints + relationType.
 * Mirrors the non-key columns of `knowledgeRelations` so the merge rule can be
 * expressed over a plain object (independent of the Convex `Doc` type).
 */
export interface EdgeAttrs {
	confidence: number;
	confidenceTag: EdgeConfidenceTag;
	provenance: EdgeProvenance;
	weight?: number;
	rationale?: string;
}

/**
 * Merge two edges that describe the same (from, to, relationType) triple into a
 * single set of attributes. `kept` is the edge that survives (its row id /
 * `createdAt` stay); `incoming` is the duplicate being folded in.
 *
 * The result takes the *strongest* evidence from either side:
 *   - confidence  → the higher numeric score,
 *   - confidenceTag → the stronger tag (extracted > inferred > ambiguous),
 *   - provenance  → the stronger provenance (manual > deterministic > llm),
 *   - weight      → the larger weight (or undefined if neither has one).
 * The `rationale` of the kept edge is preserved — we don't concatenate or
 * clobber an existing human/LLM explanation with the duplicate's.
 */
export function mergeEdgeAttrs(kept: EdgeAttrs, incoming: EdgeAttrs): EdgeAttrs {
	const confidence = Math.max(kept.confidence, incoming.confidence);
	const confidenceTag =
		tagRank(incoming.confidenceTag) > tagRank(kept.confidenceTag)
			? incoming.confidenceTag
			: kept.confidenceTag;
	const provenance =
		provenanceRank(incoming.provenance) > provenanceRank(kept.provenance)
			? incoming.provenance
			: kept.provenance;

	const weights = [kept.weight, incoming.weight].filter(
		(w): w is number => w !== undefined,
	);
	const weight = weights.length > 0 ? Math.max(...weights) : undefined;

	const merged: EdgeAttrs = {
		confidence,
		confidenceTag,
		provenance,
		rationale: kept.rationale,
	};
	if (weight !== undefined) merged.weight = weight;
	return merged;
}

/**
 * Minimum confidence at which an *inferred* edge is trusted enough to tag
 * `'inferred'` rather than `'ambiguous'`. Edges at or above the floor are
 * inferred; below it they are ambiguous (surfaced cautiously, weighed down).
 */
export const INFERRED_CONFIDENCE_FLOOR = 0.75;

/**
 * Pick the confidence tag for an inferred (non-extracted, non-manual) edge from
 * its numeric confidence. At or above {@link INFERRED_CONFIDENCE_FLOOR} →
 * `'inferred'`; below → `'ambiguous'`. (Extracted/manual edges set their tag
 * directly and never call this.)
 */
export function tagForInferredConfidence(
	confidence: number,
): Extract<EdgeConfidenceTag, 'inferred' | 'ambiguous'> {
	return confidence >= INFERRED_CONFIDENCE_FLOOR ? 'inferred' : 'ambiguous';
}

/**
 * Canonicalize an entry's `title` + `content` into the string a content hash is
 * computed over. Each field is independently trimmed, lowercased, and has its
 * internal whitespace runs collapsed to single spaces, then the two are joined
 * with a newline so the title/content boundary survives (and "a b" / "c" never
 * collides with "a" / "b c"). Deterministic and case/whitespace-insensitive: two
 * entries that differ only in casing or spacing produce the same string — and so
 * the same sha256 the caller computes from it.
 */
export function normalizeForHash(title: string, content: string): string {
	const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
	return `${norm(title)}\n${norm(content)}`;
}
