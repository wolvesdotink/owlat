/**
 * [4] Engagement-Based Send Ordering
 *
 * Maps engagement scores (0-100 from Convex contact activity)
 * to GroupMQ priority levels. During IP warming, ISPs evaluate
 * sender reputation by early engagement signals — sending to
 * active openers/clickers first maximizes positive signals.
 *
 * This is a pure mapping function with no Redis state.
 */

/**
 * Priority bands: lower number = higher priority (sent first)
 */
export const PRIORITY_BANDS = {
	HIGH: 1, // Score 80-100: recent openers/clickers
	MEDIUM: 2, // Score 50-79: moderately engaged
	LOW: 3, // Score 20-49: low engagement
	COLD: 4, // Score 0-19: cold/unengaged
	DEFAULT: 3, // When no score is provided
} as const;

/**
 * Map an engagement score to a GroupMQ priority level
 *
 * @param score Engagement score 0-100 (from Convex contact activity data)
 * @returns Priority level (1-4, lower = higher priority)
 */
export function mapToPriority(score?: number): number {
	if (score === undefined || score === null) return PRIORITY_BANDS.DEFAULT;
	if (score >= 80) return PRIORITY_BANDS.HIGH;
	if (score >= 50) return PRIORITY_BANDS.MEDIUM;
	if (score >= 20) return PRIORITY_BANDS.LOW;
	return PRIORITY_BANDS.COLD;
}

/**
 * Get a human-readable label for a priority level
 */
export function priorityLabel(priority: number): string {
	switch (priority) {
		case 1: return 'high-engagement';
		case 2: return 'medium-engagement';
		case 3: return 'low-engagement';
		case 4: return 'cold';
		default: return 'unknown';
	}
}
