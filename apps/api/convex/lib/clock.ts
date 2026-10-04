/**
 * THE UTC DAY and the clock, in one place — dependency-free by design.
 *
 * This module imports NOTHING: no `convex/values`, no `_generated/*`, no other
 * convex module (not even `./constants`, which pulls in `@owlat/shared`). That
 * is the whole point. The day arithmetic used to live in
 * `analytics/sendingReputation.ts`, a Convex FUNCTION module that registers
 * mutations and pulls in the generated API graph, so every "pure core" module
 * that only wanted the day-bucket arithmetic dragged that graph in behind it.
 *
 * Every writer and reader of a day-bucketed row must agree on where a day starts
 * and how it is spelled: the `sendDailyStats` writer and the marketing overview
 * that reads it, the pace actuator's per-UTC-day idempotency guard (an hourly
 * controller must advance a warming schedule at most once a day), the multi-day
 * send plan's day slices, the daily send caps. Two spellings of "the start of
 * today" is how an off-by-one-day bug ships, so day and clock primitives live
 * here and are imported from here. `scripts/check-utc-day.sh` flags a
 * hand-rolled `setUTCHours(0, 0, 0, 0)` or ISO-string slice anywhere else.
 *
 * The KEY FORMAT IS THE MTA'S — `YYYY-MM-DD`, the same string
 * `apps/mta/src/intelligence/warmingKeys.ts` stamps into `lastEvaluatedDate`.
 *
 * ONE NON-FINITE POLICY. Convex numbers are float64, so `NaN` and `Infinity`
 * reach these functions as valid arguments. A non-finite clock has no day:
 * `utcDayStart` answers `0` (a cap window that starts at the epoch counts
 * everything sent, so a daily cap fails CLOSED rather than reading as unused,
 * which is what a `NaN` bound on a `gte` window read would do), and `utcDayKey`
 * answers `''`, which compares equal to no stored day.
 *
 * Pure: `now` is always a parameter, except in `resolveNow`, whose job is to
 * fall back to the real clock.
 */

/** One UTC day in milliseconds. Local on purpose: see the header. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the UTC day (midnight UTC) containing `now`, or `0` for a non-finite clock. */
export function utcDayStart(now: number): number {
	if (!Number.isFinite(now)) return 0;
	return Math.floor(now / DAY_MS) * DAY_MS;
}

/** Start of the NEXT UTC day after `now` — the next cap window. */
export function nextUtcDayStart(now: number): number {
	return utcDayStart(now) + DAY_MS;
}

/**
 * The `YYYY-MM-DD` key of the UTC day containing `now` — the bucket key every
 * day-bucketed row (`sendDailyStats`, plugin LLM usage, ramp day guards) is
 * written and read under. ISO date strings sort chronologically, so an index on
 * the key supports a `gte(cutoff)` window read.
 *
 * A non-finite clock yields the empty string rather than `Invalid Date` or a
 * thrown `RangeError`: an unusable clock must compare EQUAL to no stored day at
 * all — never to a real one it could have been mistaken for.
 */
export function utcDayKey(now: number): string {
	if (!Number.isFinite(now)) return '';
	return new Date(utcDayStart(now)).toISOString().slice(0, 10);
}

/**
 * A dense `days`-long daily series ending on the UTC day of `now`, oldest first.
 *
 * A daily roll-up only has rows for days something happened; a chart needs the
 * quiet days as explicit zeros or it silently compresses the time axis. Keys in
 * `countsByKey` outside the window are ignored.
 */
export function denseDailySeries(
	countsByKey: ReadonlyMap<string, number>,
	days: number,
	now: number
): { date: string; count: number }[] {
	const series: { date: string; count: number }[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const date = utcDayKey(now - i * DAY_MS);
		series.push({ date, count: countsByKey.get(date) ?? 0 });
	}
	return series;
}

/**
 * Normalize an optional caller-supplied clock to a usable timestamp.
 *
 * Convex numbers are float64, so `NaN`/`Infinity` are valid arguments to any
 * `v.optional(v.number())` clock parameter. Letting one through turns a cutoff
 * into `NaN` and a retention sweep into a silent permanent no-op, so a
 * non-finite candidate falls back to the real clock exactly as an absent one
 * does.
 */
export function resolveNow(candidate: number | undefined): number {
	return candidate !== undefined && Number.isFinite(candidate) ? candidate : Date.now();
}

/**
 * The first instant certainly AFTER an event stamped `at`, read at whole-second
 * precision (#1228).
 *
 * Mandrill stamps events in whole seconds while Owlat's own timestamps are
 * millis, so an event stamped 12:00:00 happened somewhere in [12:00:00,
 * 12:00:01). Every "did this happen after the event?" comparison against a
 * provider stamp uses this bound, which settles a same-second tie IN FAVOUR OF
 * THE EVENT: a subscribe or a removal in the event's own second counts as
 * before it. A non-finite stamp answers `NaN`, which compares false, so nothing
 * counts as after it and the event wins there too.
 */
export function afterEventSecond(at: number): number {
	return Math.floor(at / 1000) * 1000 + 1000;
}
