/**
 * The send intake's engagement-score boundary.
 *
 * The score reaches priority banding through `>=` comparisons, where a JSON
 * string ("90") coerces and buys HIGH priority, and it is journalled onto the
 * job and into the outcome record. Only a finite number inside the producer's
 * 0-100 range is a score; anything else is absent and bands DEFAULT.
 */

import { logger } from '../monitoring/logger.js';

function engagementScoreOrAbsent(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	return value >= 0 && value <= 100 ? value : undefined;
}

/**
 * Read the score off an unvalidated body, logging anything dropped.
 *
 * Banding DEFAULT rather than rejecting keeps a non-essential field from
 * failing a send, but a producer that regresses to `"90"` would otherwise lose
 * HIGH banding permanently with no signal anywhere.
 */
export function readEngagementScore(messageId: string, value: unknown): number | undefined {
	const score = engagementScoreOrAbsent(value);
	if (value !== undefined && score === undefined) {
		logger.warn(
			{
				messageId,
				// A bounded RENDERING, never the parsed value: it is unvalidated
				// producer JSON of any size, and the quotes are what identify the
				// regression — `"90"` and `90` are indistinguishable otherwise.
				engagementScore: JSON.stringify(value)?.slice(0, 64),
			},
			'Ignoring a malformed engagement score — banding DEFAULT'
		);
	}
	return score;
}
