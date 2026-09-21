/**
 * When to spend the extra generation on alternative review drafts. Split out
 * of agent/shared/draftService.ts (file-size ratchet); the service re-exports
 * `shouldOfferDraftOptions` so existing imports resolve.
 */

import type { DraftQuality } from './draftService';

// ─── Multi-option review drafts ──────────────────────────────────────────────
//
// On cases that will land in human review anyway — the classifier is unsure OR
// the draft-quality self-check scored low / is unknown — spend ONE extra
// generation to offer the reviewer 2–3 diverse drafts they can approve in one
// tap. Gating bounds the extra cost to drafts a human is going to look at.
// FAIL-SOFT: any failure degrades to the single primary draft.

/** Below this classifier confidence, offer alternative drafts. */
const MULTI_OPTION_CONFIDENCE_THRESHOLD = 0.8;
/** Below this draft-quality score (or when unknown/null), offer alternative drafts. */
const MULTI_OPTION_QUALITY_THRESHOLD = 0.8;

/**
 * Decide whether to spend the extra generation on alternative drafts. True when
 * the message is heading to human review anyway: low classifier confidence, or a
 * low / unknown (null) draft-quality self-check.
 */
export function shouldOfferDraftOptions(
	confidence: number,
	draftQuality: DraftQuality | null
): boolean {
	if (confidence < MULTI_OPTION_CONFIDENCE_THRESHOLD) return true;
	if (draftQuality === null) return true;
	if (draftQuality.score < MULTI_OPTION_QUALITY_THRESHOLD) return true;
	return false;
}
