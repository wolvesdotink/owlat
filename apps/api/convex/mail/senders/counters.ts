/**
 * Sender counters: 13 calendar-week buckets per sender, labelled
 * "about 90 days" in the UI and never "90 days".
 *
 * Bucket 0 is the week that starts at `weekAnchor` (Monday 00:00 UTC), bucket
 * 12 the oldest. Rolling forward shifts the arrays and drops what falls off.
 *
 * Cohort rule: an open is counted in the bucket of the week the message was
 * DELIVERED, not the week it was opened. Opened and delivered then describe the
 * same mail, so the read rate (opened ÷ delivered over the window) can never
 * pass 100%, and an open of mail older than the window counts nowhere.
 *
 * Pure and isolate-safe; the writers are `mail/senders/delivery.ts` and
 * `mail/senders/opens.ts`.
 */

import { DAY_MS } from '../../lib/constants';
import { utcDayStart } from '../../lib/clock';

/** How many weekly buckets a profile keeps. */
export const SENDER_WEEK_BUCKETS = 13;

export const WEEK_MS = 7 * DAY_MS;

/** Monday 00:00 UTC of the week holding `at`. */
export function utcWeekStart(at: number): number {
	const day = utcDayStart(at);
	// getUTCDay: Sunday 0 … Saturday 6; Monday-based offset.
	const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
	return day - sinceMonday * DAY_MS;
}

function zeros(length: number): number[] {
	return Array.from({ length }, () => 0);
}

export interface SenderWeeks {
	weekAnchor: number;
	deliveredWeeks: number[];
	openedWeeks: number[];
}

/** Fresh, empty buckets anchored at the week of `now`. */
export function emptySenderWeeks(now: number): SenderWeeks {
	return {
		weekAnchor: utcWeekStart(now),
		deliveredWeeks: zeros(SENDER_WEEK_BUCKETS),
		openedWeeks: zeros(SENDER_WEEK_BUCKETS),
	};
}

/** Pad or cut a stored array to exactly the bucket count (tolerates old rows). */
function normalized(weeks: readonly number[]): number[] {
	const out = weeks.slice(0, SENDER_WEEK_BUCKETS);
	while (out.length < SENDER_WEEK_BUCKETS) out.push(0);
	return out;
}

/**
 * Roll the buckets forward so bucket 0 is the week of `now`. A clock that
 * reads earlier than the anchor (skew) keeps the stored anchor.
 */
export function rollSenderWeeks(weeks: SenderWeeks, now: number): SenderWeeks {
	const anchor = utcWeekStart(now);
	const shift = Math.round((anchor - weeks.weekAnchor) / WEEK_MS);
	if (shift <= 0) {
		return {
			weekAnchor: weeks.weekAnchor,
			deliveredWeeks: normalized(weeks.deliveredWeeks),
			openedWeeks: normalized(weeks.openedWeeks),
		};
	}
	if (shift >= SENDER_WEEK_BUCKETS) return emptySenderWeeks(now);
	const pad = zeros(shift);
	return {
		weekAnchor: anchor,
		deliveredWeeks: normalized([...pad, ...weeks.deliveredWeeks]),
		openedWeeks: normalized([...pad, ...weeks.openedWeeks]),
	};
}

/** The bucket a moment falls in, or null outside the window. */
export function senderWeekIndex(weeks: Pick<SenderWeeks, 'weekAnchor'>, at: number): number | null {
	const index = Math.round((weeks.weekAnchor - utcWeekStart(at)) / WEEK_MS);
	return index >= 0 && index < SENDER_WEEK_BUCKETS ? index : null;
}

/** Count one live delivery at `deliveredAt` (normally now). */
export function addSenderDelivery(weeks: SenderWeeks, deliveredAt: number): SenderWeeks {
	const rolled = rollSenderWeeks(weeks, deliveredAt);
	const index = senderWeekIndex(rolled, deliveredAt);
	if (index === null) return rolled;
	rolled.deliveredWeeks[index] = (rolled.deliveredWeeks[index] ?? 0) + 1;
	return rolled;
}

/**
 * Count the first open of a message delivered at `deliveredAt`, seen at `now`,
 * in its delivery week (the cohort rule above). Never lifts a bucket's opens
 * above its deliveries.
 */
export function addSenderOpen(weeks: SenderWeeks, deliveredAt: number, now: number): SenderWeeks {
	const rolled = rollSenderWeeks(weeks, now);
	const index = senderWeekIndex(rolled, deliveredAt);
	if (index === null) return rolled;
	const opened = (rolled.openedWeeks[index] ?? 0) + 1;
	rolled.openedWeeks[index] = Math.min(opened, rolled.deliveredWeeks[index] ?? 0);
	return rolled;
}

export interface SenderWindowTotals {
	delivered: number;
	opened: number;
	/** opened ÷ delivered, 0 when nothing was delivered. */
	readRate: number;
}

/** Delivered and opened over the window as it stands at `now`. */
export function senderWindowTotals(weeks: SenderWeeks, now: number): SenderWindowTotals {
	const rolled = rollSenderWeeks(weeks, now);
	const delivered = rolled.deliveredWeeks.reduce((sum, n) => sum + n, 0);
	const opened = rolled.openedWeeks.reduce((sum, n) => sum + n, 0);
	return { delivered, opened, readRate: delivered > 0 ? opened / delivered : 0 };
}
