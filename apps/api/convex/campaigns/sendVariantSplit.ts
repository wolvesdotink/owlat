/**
 * Pure A/B variant split helpers consumed by the Campaign send
 * orchestrator (module). Lives outside `emails.ts` (which is
 * `'use node'`) so the helpers can be unit-tested without pulling in
 * the workpool / provider / Convex Node-runtime stack.
 *
 * See CONTEXT.md "Campaign send orchestrator (module)" for the
 * two-phase A/B fanout model.
 *
 * The split is computed by a DETERMINISTIC per-contact hash rather than a
 * global shuffle, so the A/B send streams through the same checkpointed
 * walker as a plain send — no read-cap ceiling, no in-memory materialize,
 * and a winner-remainder phase that needs no who-got-the-test scan
 * (remainder membership is recomputable from the same hash).
 */

import type { Doc } from '../_generated/dataModel';

export type AbFanout = {
	config: NonNullable<Doc<'campaigns'>['abTestConfig']>;
};

/**
 * Returns the A/B fanout context when the campaign is actively in the
 * A/B testing phase. Returns null for non-A/B campaigns, A/B campaigns
 * whose lifecycle has already transitioned to `winner_selected` (those
 * go through `sendCampaignWinnerToRemainder`), pending A/B campaigns
 * (the cross-machine effect hasn't fired yet), and any state mismatch.
 */
export function resolveAbFanout(campaign: Doc<'campaigns'>): AbFanout | null {
	if (!campaign.isABTest) return null;
	if (campaign.abTestStatus !== 'testing') return null;
	if (!campaign.abTestConfig) return null;
	return { config: campaign.abTestConfig };
}

// ─── Deterministic cohort hashing ──────────────────────────────────────────
//
// The single source of truth for "which cohort is this contact in". Both send
// phases derive cohort membership from `hashFraction(campaignId, contactId)`:
//   - PHASE 1 (test): a contact is in the test cohort iff `h < testFraction`;
//     within the cohort the variant is sub-bucketed across the A/B weights.
//   - PHASE 2 (winner): a contact is in the remainder iff `h >= testFraction`.
// Because the two predicates partition `[0, 1)` at the same `testFraction`, the
// cohorts are provably disjoint and exhaustive — no contact can receive both a
// test variant and the winner, and no eligible contact is dropped.

/**
 * Deterministic FNV-1a hash of `${campaignId}:${contactId}` mapped to a number
 * in `[0, 1)`. A pure function of its inputs — no randomness, no clock — so it
 * yields the SAME bucket on every page, every resume, and across both phases,
 * in any runtime (it is plain JS, callable from the Node action and from
 * non-node queries alike).
 *
 * FNV-1a over the UTF-16 code units of the joined ids; the 32-bit accumulator
 * is scaled by 2^32 to land in `[0, 1)`. Distribution is uniform enough that a
 * large audience's test-cohort fraction converges on `testFraction`.
 */
export function hashFraction(campaignId: string, contactId: string): number {
	const key = `${campaignId}:${contactId}`;
	// FNV-1a 32-bit.
	let h = 0x811c9dc5; // offset basis
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		// 32-bit FNV prime multiply via shifts (stays within double precision).
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	// h is an unsigned 32-bit int; scale into [0, 1).
	return h / 0x100000000;
}

/**
 * The fraction of the eligible audience that forms the A/B test cohort.
 * `splitPercentage` is "% per variant", so the cohort is `2 × splitPercentage`
 * percent of the audience (e.g. 20 → 0.4 cohort, 0.6 remainder). Clamped to
 * `[0, 1]` defensively (the wizard already bounds split to 10–50).
 */
export function testFractionForSplit(splitPercentage: number): number {
	const raw = (2 * splitPercentage) / 100;
	if (raw < 0) return 0;
	if (raw > 1) return 1;
	return raw;
}

/**
 * Classify one contact's hash against an active A/B split.
 *   - `h >= testFraction` ⇒ remainder (held back for the winner phase).
 *   - `h < testFraction`  ⇒ test cohort, sub-bucketed across the A/B weights:
 *     the lower half of `[0, testFraction)` is variant A, the upper half B.
 *     (Per-variant weight is equal — `splitPercentage` each — so the split
 *     point is the cohort midpoint.)
 *
 * Returns `'A' | 'B'` for a cohort member, or `null` for the remainder.
 */
export function variantForHash(h: number, testFraction: number): 'A' | 'B' | null {
	if (h >= testFraction) return null; // remainder
	if (testFraction <= 0) return null; // no cohort
	// Position within the cohort interval [0, testFraction): lower half → A.
	const midpoint = testFraction / 2;
	return h < midpoint ? 'A' : 'B';
}
