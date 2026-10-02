/**
 * Send-time engagement profile — the PURE model behind "Optimized per
 * contact" scheduling (ADR-0068). Nothing here reads the database or the
 * clock; every instant is a parameter.
 *
 * THE SHAPE. Two marginal histograms rather than one hour-of-week grid: 24
 * local hours of the day and 7 local weekdays. A contact engages a handful of
 * times a month, so a 168-cell grid would be almost empty for everyone; the
 * hour histogram fills up after a few events, and the weekday histogram only
 * tilts the choice when the send window spans more than one day. A slot's
 * score is the (lightly smoothed) hour weight times the weekday weight.
 *
 * TIME DECAY. Every event's weight halves every `SEND_TIME_HALF_LIFE_DAYS`, so
 * a contact who moved from reading at lunch to reading in the evening is
 * scheduled for the evening within a couple of months. Because a sum of
 * exponentially decayed terms decays exponentially, the stored histogram is
 * kept "as of" one instant (`asOf`) and folding a new event is O(1): decay to
 * the event and add it. An event older than `asOf` (the backfill racing a live
 * event) is added already decayed, which gives the same result as folding the
 * events in order.
 *
 * WHAT COUNTS. The caller decides; see `delivery/sendLifecycle/sendTimeEffects.ts`
 * and `migrations/0064_backfill_send_time_profiles.ts`. Only reader clicks and
 * reader opens of campaign mail are folded: Apple Mail Privacy Protection,
 * security scanners and arrival prefetches never reach this module.
 */

import { DAY_MS } from '../lib/constants';
import { isValidTimeZone } from '../lib/emailHelpers';

export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;

/** Half-life of one engagement's weight. */
export const SEND_TIME_HALF_LIFE_DAYS = 60;

/**
 * Weight per engagement kind. A click is the stronger signal: it is always a
 * person, and it says the email was read, not only displayed.
 */
export const SEND_TIME_ENGAGEMENT_WEIGHTS = { open: 1, click: 2 } as const;
export type SendTimeEngagementKind = keyof typeof SEND_TIME_ENGAGEMENT_WEIGHTS;

/**
 * Decayed weight a contact's profile needs before it picks the contact's send
 * time: about three recent opens, or a recent click and an open. Below it the
 * planner falls back to the organization's histogram.
 */
export const CONTACT_MIN_EVIDENCE = 3;

/** Decayed weight the organization histogram needs before it is used. */
export const ORGANIZATION_MIN_EVIDENCE = 20;

export interface SendTimeHistogram {
	hours: number[];
	days: number[];
	total: number;
	asOf: number;
}

export interface SendTimeProfile extends SendTimeHistogram {
	timeZone: string;
}

/** One engagement, already placed in local time. */
export interface SendTimeEngagement {
	at: number;
	kind: SendTimeEngagementKind;
	/** Local hour of day, 0-23. */
	hour: number;
	/** Local weekday, 0 = Sunday. */
	weekday: number;
}

function decayFactor(from: number, to: number): number {
	if (!(to > from)) return 1;
	return Math.pow(2, -(to - from) / (SEND_TIME_HALF_LIFE_DAYS * DAY_MS));
}

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Whether a stored histogram has the shape this module writes. A row that does
 * not (hand-edited, or a future shape read by an old build) is treated as
 * empty rather than trusted.
 */
export function isWellFormedHistogram(
	h: SendTimeHistogram | null | undefined
): h is SendTimeHistogram {
	return (
		!!h &&
		Array.isArray(h.hours) &&
		h.hours.length === HOURS_PER_DAY &&
		h.hours.every(isCount) &&
		Array.isArray(h.days) &&
		h.days.length === DAYS_PER_WEEK &&
		h.days.every(isCount) &&
		isCount(h.total) &&
		Number.isFinite(h.asOf)
	);
}

export function emptyHistogram(asOf: number): SendTimeHistogram {
	return {
		hours: Array.from({ length: HOURS_PER_DAY }, () => 0),
		days: Array.from({ length: DAYS_PER_WEEK }, () => 0),
		total: 0,
		asOf,
	};
}

/** The histogram as of `at`, or unchanged when `at` is not later than `asOf`. */
export function decayHistogramTo(h: SendTimeHistogram, at: number): SendTimeHistogram {
	const f = decayFactor(h.asOf, at);
	if (f === 1) return h;
	return {
		hours: h.hours.map((x) => x * f),
		days: h.days.map((x) => x * f),
		total: h.total * f,
		asOf: at,
	};
}

/** Fold one engagement into a histogram (or start one). Returns a new object. */
export function foldEngagement(
	h: SendTimeHistogram | null | undefined,
	e: SendTimeEngagement
): SendTimeHistogram {
	const base = isWellFormedHistogram(h) ? h : emptyHistogram(e.at);
	const current = decayHistogramTo(base, e.at);
	// An event older than the histogram's instant arrives already decayed.
	const weight = SEND_TIME_ENGAGEMENT_WEIGHTS[e.kind] * decayFactor(e.at, current.asOf);
	const hours = current.hours.slice();
	const days = current.days.slice();
	const hour = ((Math.floor(e.hour) % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
	const weekday = ((Math.floor(e.weekday) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
	hours[hour] = (hours[hour] ?? 0) + weight;
	days[weekday] = (days[weekday] ?? 0) + weight;
	return { hours, days, total: current.total + weight, asOf: current.asOf };
}

/** Add `b` into `a`, both brought to the later of their instants. */
export function addHistograms(a: SendTimeHistogram, b: SendTimeHistogram): SendTimeHistogram {
	const at = Math.max(a.asOf, b.asOf);
	const x = decayHistogramTo(a, at);
	const y = decayHistogramTo(b, at);
	return {
		hours: x.hours.map((value, i) => value + (y.hours[i] ?? 0)),
		days: x.days.map((value, i) => value + (y.days[i] ?? 0)),
		total: x.total + y.total,
		asOf: at,
	};
}

/** Decayed evidence behind a histogram at `now`. */
export function evidenceAt(h: SendTimeHistogram | null | undefined, now: number): number {
	if (!isWellFormedHistogram(h)) return 0;
	return h.total * decayFactor(h.asOf, now);
}

/**
 * The hour histogram spread a little onto its neighbours (half to the hour,
 * a quarter to each side, wrapping at midnight). Habits are fuzzy: someone who
 * opened at 8:55 and 9:10 should get a clear 9:00, and a single stray event
 * should not win over a cluster next to it.
 */
function smoothedHours(hours: readonly number[]): number[] {
	return hours.map(
		(x, i) =>
			0.5 * x +
			0.25 * (hours[(i + HOURS_PER_DAY - 1) % HOURS_PER_DAY] ?? 0) +
			0.25 * (hours[(i + 1) % HOURS_PER_DAY] ?? 0)
	);
}

/**
 * A scorer for candidate slots of one histogram. Scale does not matter (decay
 * multiplies every slot by the same factor), only the order. The weekday
 * factor adds a uniform prior so a weekday with no events yet is discounted,
 * not ruled out.
 */
export function slotScorer(h: SendTimeHistogram): (hour: number, weekday: number) => number {
	const hours = smoothedHours(h.hours);
	const prior = h.total / DAYS_PER_WEEK;
	return (hour, weekday) => (hours[hour] ?? 0) * ((h.days[weekday] ?? 0) + prior);
}

/** The local hour with the most (smoothed) engagement, or null for an empty histogram. */
export function peakHour(h: SendTimeHistogram | null | undefined): number | null {
	if (!isWellFormedHistogram(h) || h.total <= 0) return null;
	const hours = smoothedHours(h.hours);
	let best = 0;
	for (let i = 1; i < HOURS_PER_DAY; i++) if ((hours[i] ?? 0) > (hours[best] ?? 0)) best = i;
	return best;
}

/** The zone a contact is bucketed and planned in: its own, the organization's, or UTC. */
export function effectiveTimeZone(
	contactZone: string | undefined,
	defaultTimezone: string | undefined
): string {
	if (isValidTimeZone(contactZone)) return contactZone;
	return isValidTimeZone(defaultTimezone) ? defaultTimezone : 'UTC';
}
