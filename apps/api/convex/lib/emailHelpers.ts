import { DAY_MS } from './constants';
/**
 * DST-correct send-time scheduling for timezone-staggered campaigns.
 *
 * "Send at 9am in each recipient's local time" must resolve against a real IANA
 * zone (via `Intl`), not a static UTC-offset table — Europe/Berlin is +1 in
 * winter and +2 in summer, so a fixed offset is up to an hour wrong half the
 * year, and the requested wall-clock hour was ignored entirely. We compute the
 * absolute UTC instant of the next `hour:minute` local occurrence per zone.
 */

type WallClock = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

/** Wall-clock parts of `instant` as observed in `timeZone`. */
function zonedParts(instant: number, timeZone: string): WallClock {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	}).formatToParts(new Date(instant));
	const out: Record<string, number> = {};
	for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
	// Intl renders midnight as hour 24 in some engines; normalize to 0.
	if (out['hour'] === 24) out['hour'] = 0;
	return out as unknown as WallClock;
}

/**
 * One formatter per zone. Building an `Intl.DateTimeFormat` costs far more
 * than formatting with it, and the send-time planner reads local parts for
 * every candidate hour of every recipient.
 */
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Local hour (0-23), minute, second and weekday (0 = Sunday) of `instant` in
 * `timeZone`. The zone must be valid (see `isValidTimeZone`).
 */
export function localTimeParts(
	instant: number,
	timeZone: string
): { hour: number; minute: number; second: number; weekday: number } {
	let formatter = weekdayFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
		});
		weekdayFormatters.set(timeZone, formatter);
	}
	const out: Record<string, number> = {};
	for (const p of formatter.formatToParts(new Date(instant))) {
		if (p.type !== 'literal') out[p.type] = Number(p.value);
	}
	const hour = out['hour'] === 24 ? 0 : (out['hour'] ?? 0);
	const weekday = new Date(
		Date.UTC(out['year'] ?? 1970, (out['month'] ?? 1) - 1, out['day'] ?? 1)
	).getUTCDay();
	return { hour, minute: out['minute'] ?? 0, second: out['second'] ?? 0, weekday };
}

/** UTC offset (ms) of `timeZone` at `instant` (zone wall-clock minus UTC). */
function zoneOffsetMs(instant: number, timeZone: string): number {
	const p = zonedParts(instant, timeZone);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return asUtc - instant;
}

/** The UTC instant at which `timeZone`'s wall clock reads y-mo-d hh:mm:00. */
function wallClockToUtc(
	timeZone: string,
	y: number,
	mo: number,
	d: number,
	h: number,
	mi: number
): number {
	// Fixed-point: treat the wall clock as UTC, subtract the zone offset, then
	// recompute the offset at the candidate instant to settle DST transitions.
	let utc = Date.UTC(y, mo - 1, d, h, mi, 0);
	for (let i = 0; i < 2; i++) {
		utc = Date.UTC(y, mo - 1, d, h, mi, 0) - zoneOffsetMs(utc, timeZone);
	}
	return utc;
}

/** Whether `timeZone` is a usable IANA zone for `Intl`. */
export function isValidTimeZone(timeZone: string | undefined): timeZone is string {
	if (!timeZone) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone });
		return true;
	} catch {
		return false;
	}
}

/**
 * The next UTC instant (strictly after `nowMs`) at which it is
 * `scheduledHour:scheduledMinute` local time in `timeZone`. Unknown/invalid
 * zones fall back to `fallback` (default 'UTC'). DST-correct.
 */
export function resolveNextSendTime(
	timeZone: string | undefined,
	scheduledHour: number,
	scheduledMinute: number,
	nowMs: number,
	fallback = 'UTC'
): number {
	const zone = isValidTimeZone(timeZone) ? timeZone : fallback;
	const today = zonedParts(nowMs, zone);
	let target = wallClockToUtc(
		zone,
		today.year,
		today.month,
		today.day,
		scheduledHour,
		scheduledMinute
	);
	if (target <= nowMs) {
		// Already past in this zone — roll to the same wall-clock time tomorrow,
		// reading "tomorrow" in-zone so month/year/DST day-length all stay correct.
		const tomorrow = zonedParts(nowMs + DAY_MS, zone);
		target = wallClockToUtc(
			zone,
			tomorrow.year,
			tomorrow.month,
			tomorrow.day,
			scheduledHour,
			scheduledMinute
		);
	}
	return target;
}
