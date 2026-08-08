/**
 * THE TWO SPANS THE MEASUREMENT SCREENS RENDER, PUT INTO WORDS (#510).
 *
 * The delivery dashboard query answers over two of them and says so on the wire:
 * counters, rates and the trend over a REPORTED window of whole UTC days, and
 * every gate verdict over the ramp controller's own, shorter DECIDING span —
 * which is what makes the verdicts on these screens the verdicts the cron
 * reached. A screen naming only one of them puts a week's dates over numbers
 * decided in a day, which is the confusion the server-side fix removed.
 *
 * BOTH LABELS ARE DERIVED FROM THE SERVER'S BOUNDS. Neither span is written out
 * as a constant here: the deciding one is the controller's evaluation window,
 * and a screen holding its own copy of "24 hours" would keep printing it after
 * that cadence moved.
 *
 * A SIBLING OF `deliverabilityMeasurement.ts` rather than a section inside it:
 * that module is at the file-size cap, and these two functions are the only ones
 * on the screen that answer about a span rather than about a cell.
 */

import { formatNumber, formatShortDate } from '~/utils/formatters';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The window the COUNTERS are over. `windowEnd` is exclusive, so the label names
 * the last day actually included rather than the first day that is not.
 */
export function reportedWindowLabel(dashboard: {
	readonly windowStart: number;
	readonly windowEnd: number;
}): string {
	return `${formatShortDate(dashboard.windowStart)} – ${formatShortDate(dashboard.windowEnd - 1)}`;
}

/**
 * The span the VERDICTS are over, in words — "the last 24 hours".
 *
 * A degenerate or reversed pair falls back to naming no span at all. It is a
 * fault in the read, and "the last 0 hours" printed under every check on the
 * screen would be a confident, wrong statement about what was measured.
 */
export function decisionWindowLabel(dashboard: {
	readonly decisionWindowStart: number;
	readonly decisionWindowEnd: number;
}): string {
	const hours = Math.round((dashboard.decisionWindowEnd - dashboard.decisionWindowStart) / HOUR_MS);
	if (!Number.isFinite(hours) || hours < 1) return 'the latest measurements';
	if (hours % 24 !== 0) return `the last ${formatNumber(hours)} hours`;
	const days = hours / 24;
	return days === 1 ? 'the last 24 hours' : `the last ${formatNumber(days)} days`;
}
