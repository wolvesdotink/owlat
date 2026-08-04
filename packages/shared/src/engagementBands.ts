/**
 * Contact engagement bands — the ONE definition of the 80/50/20 cut points.
 *
 * Two packages act on the same three numbers and must never drift apart:
 *  - the PRODUCER, `apps/api/convex/analytics/engagementScore.ts`, which
 *    calibrates its 0-100 curve so realistic timelines actually populate all
 *    four bands (deliverability plan P0-2);
 *  - the CONSUMER, `apps/mta/src/intelligence/engagementPriority.ts`, which
 *    maps a score onto a GroupMQ priority level.
 *
 * They previously carried a hand-copied literal each, pinned only by a copy of
 * the same literal in a test — so moving one side broke nothing and silently
 * re-banded the whole book. Both sides now import from here.
 */

/**
 * Inclusive lower bound of each band. A score at or above `high` is high, at or
 * above `medium` is medium, at or above `low` is low; anything below `low` is
 * cold.
 */
export const ENGAGEMENT_BAND_CUTS = {
	high: 80,
	medium: 50,
	low: 20,
} as const;

export type EngagementBand = 'high' | 'medium' | 'low' | 'cold';

/**
 * The band a 0-100 score falls in. A non-finite score carries no information,
 * so it reads as `cold` — the band with the least aggressive treatment.
 */
export function engagementBandForScore(score: number): EngagementBand {
	if (!Number.isFinite(score)) return 'cold';
	if (score >= ENGAGEMENT_BAND_CUTS.high) return 'high';
	if (score >= ENGAGEMENT_BAND_CUTS.medium) return 'medium';
	if (score >= ENGAGEMENT_BAND_CUTS.low) return 'low';
	return 'cold';
}
