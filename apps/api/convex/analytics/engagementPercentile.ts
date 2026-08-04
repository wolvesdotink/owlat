/**
 * Engagement PERCENTILE — the ranking seam, split out of `engagementScore.ts`.
 *
 * Scoring answers "how engaged is this contact"; this module answers "where in
 * a cohort does that score sit", which is a different question with a different
 * consumer: the stratified half of the mix assignment (plan D8). It lives in its
 * own file because `engagementScore.ts` is at the ~500 LOC guideline
 * CONVENTIONS.md sets, and because ranking has no business knowing how a score
 * is computed.
 */

/**
 * The seam plan P2-5 consumes for stratified assignment: the percentile
 * INTERVAL a score occupies within a cohort. `cohortAscending` must be sorted
 * ascending. `lower` is the fraction of the
 * cohort scoring strictly below it, `upper` the fraction scoring at or below.
 *
 * The two differ exactly when the score is TIED, and the width of the gap is
 * the size of the tied group. A consumer that ranks recipients (stratified
 * assignment, plan D8) needs the interval rather than a single number: handing
 * every member of a tied group the group's upper percentile means an entirely
 * tied cohort — a cold or freshly-imported list — ranks everybody at 1.0, and
 * any "top s fraction" cut then selects the whole cohort. The interval lets the
 * consumer spread the tie instead.
 */
export function engagementPercentileRange(
	cohortAscending: readonly number[],
	score: number
): { lower: number; upper: number } {
	const size = cohortAscending.length;
	// An empty cohort has no ordering information, so it returns the neutral 0.5
	// rather than pretending the contact is at either extreme.
	if (size === 0) return { lower: 0.5, upper: 0.5 };
	return {
		lower: boundIndex(cohortAscending, score, 'lower') / size,
		upper: boundIndex(cohortAscending, score, 'upper') / size,
	};
}

/**
 * `lower`: first index whose value is >= `score`. `upper`: first index whose
 * value is strictly greater than `score`.
 */
function boundIndex(
	cohortAscending: readonly number[],
	score: number,
	bound: 'lower' | 'upper'
): number {
	let low = 0;
	let high = cohortAscending.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		const value = cohortAscending[mid];
		const isBelow = value === undefined || (bound === 'upper' ? value <= score : value < score);
		if (isBelow) low = mid + 1;
		else high = mid;
	}
	return low;
}
