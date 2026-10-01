/**
 * Dates for Answer mode's round 2 ("It isn't ready yet" → "When can you send
 * it?"): which weekday the second chip names, the reminder time an answer
 * resolves to, and how the promised date reads in the draft.
 *
 * All of it happens in the owner's time zone, which the web sends as an IANA
 * name (`Intl.DateTimeFormat().resolvedOptions().timeZone`): "tomorrow" is the
 * owner's tomorrow, and the reminder fires at 09:00 on the owner's clock.
 * Without a usable zone everything falls back to UTC.
 *
 * Pure (no Convex context), so the policy module and its tests import it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MORNING_HOUR = 9;
const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAYS_DE = [
	'sonntag',
	'montag',
	'dienstag',
	'mittwoch',
	'donnerstag',
	'freitag',
	'samstag',
];

/** The zone if the runtime knows it, otherwise undefined (callers use UTC). */
export function normalizeTimeZone(timeZone: string | undefined): string | undefined {
	const name = timeZone?.trim();
	if (!name || name.length > 64) return undefined;
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
	} catch {
		return undefined;
	}
}

/** Wall-clock fields of `at` in `timeZone`. */
function wallClock(at: number, timeZone: string) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(at);
	const field = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((part) => part.type === type)?.value ?? 0);
	return {
		year: field('year'),
		month: field('month'),
		day: field('day'),
		hour: field('hour'),
		minute: field('minute'),
		second: field('second'),
	};
}

/** How far the zone's clock is ahead of UTC at `at`, in ms. */
function zoneOffset(at: number, timeZone: string): number {
	const w = wallClock(at, timeZone);
	const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
	return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The owner's calendar day at `at`, as the UTC midnight of the same date. Day
 * arithmetic and weekdays then work with plain UTC getters.
 */
function localDay(at: number, timeZone: string): number {
	const w = wallClock(at, timeZone);
	return Date.UTC(w.year, w.month - 1, w.day);
}

/** 09:00 on the owner's clock on `day` (a {@link localDay} value). */
function morningOf(day: number, timeZone: string): number {
	const wall = day + MORNING_HOUR * 60 * 60 * 1000;
	// Twice: the second pass picks the offset in force at the answer, which
	// differs from the first guess only across a daylight-saving change.
	const guess = wall - zoneOffset(wall, timeZone);
	return wall - zoneOffset(guess, timeZone);
}

/** The English weekday name `days` after today on the owner's calendar. */
export function weekdayAfter(now: number, days: number, timeZone?: string): string {
	const name = WEEKDAYS_EN[new Date(localDay(now, timeZone ?? 'UTC') + days * DAY_MS).getUTCDay()]!;
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The reminder time an answer to the follow-up question names, or undefined
 * when it names none the server can resolve (free text like "next week" still
 * reaches the draft verbatim). Accepts a picker date (`2026-10-02`), a full ISO
 * timestamp, "tomorrow" and weekday names in English or German, and resolves a
 * day to 09:00 in `timeZone` (UTC when absent). Always in the future.
 */
export function resolveFollowUpAt(
	value: string,
	now: number,
	timeZone?: string
): number | undefined {
	const zone = timeZone ?? 'UTC';
	const text = value.trim().toLowerCase();
	const today = localDay(now, zone);
	let at: number | undefined;
	const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (isoDay) {
		at = morningOf(Date.UTC(Number(isoDay[1]), Number(isoDay[2]) - 1, Number(isoDay[3])), zone);
	} else if (/^\d{4}-\d{2}-\d{2}t/.test(text)) {
		const parsed = Date.parse(value.trim());
		at = Number.isNaN(parsed) ? undefined : parsed;
	} else if (text === 'tomorrow' || text === 'morgen') {
		at = morningOf(today + DAY_MS, zone);
	} else {
		let weekday = WEEKDAYS_EN.indexOf(text);
		if (weekday < 0) weekday = WEEKDAYS_DE.indexOf(text);
		if (weekday >= 0) {
			const ahead = (weekday - new Date(today).getUTCDay() + 7) % 7 || 7;
			at = morningOf(today + ahead * DAY_MS, zone);
		}
	}
	return at !== undefined && Number.isFinite(at) && at > now ? at : undefined;
}

/** The promised day as the draft states it ("Fri, 02 Oct 2026"), on the owner's calendar. */
export function formatPromisedDay(at: number, timeZone?: string): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timeZone ?? 'UTC',
		weekday: 'short',
		day: '2-digit',
		month: 'short',
		year: 'numeric',
	}).formatToParts(at);
	const field = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${field('weekday')}, ${field('day')} ${field('month')} ${field('year')}`;
}
