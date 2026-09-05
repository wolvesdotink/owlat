/**
 * THE UTC DAY, in one place.
 *
 * Three modules need to agree about where a day starts: the pace actuator's
 * per-UTC-day idempotency guard (plan D19 — an hourly controller must advance a
 * warming schedule at most once a day), the multi-day send plan's day slices,
 * and the campaign capacity planner. Two spellings of "the start of today" is
 * how an off-by-one-day bug ships, and this one would be invisible: the
 * controller would advance twice on the boundary day.
 *
 * The KEY FORMAT IS THE MTA'S — `YYYY-MM-DD`, the same string
 * `apps/mta/src/intelligence/warmingKeys.ts` stamps into `lastEvaluatedDate`.
 * The guard on this side means the same thing as the guard on that side, so it
 * is written the same way.
 *
 * Pure: `now` is always a parameter (plan D15).
 */

import { DAY_MS } from './constants';

/** Start of the UTC day containing `now`, or `0` for a non-finite clock. */
export function utcDayStart(now: number): number {
	if (!Number.isFinite(now)) return 0;
	return Math.floor(now / DAY_MS) * DAY_MS;
}

/** Start of the NEXT UTC day after `now` — the next cap window. */
export function nextUtcDayStart(now: number): number {
	return utcDayStart(now) + DAY_MS;
}

/**
 * The `YYYY-MM-DD` key of the UTC day containing `now`.
 *
 * A non-finite clock yields the empty string rather than `Invalid Date`: the
 * one caller is an idempotency guard, and an unusable clock must compare EQUAL
 * to no stored day at all — never to a real one it could have been mistaken for.
 */
export function utcDayKey(now: number): string {
	if (!Number.isFinite(now)) return '';
	return new Date(utcDayStart(now)).toISOString().slice(0, 10);
}
