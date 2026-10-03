/**
 * Business-hours arithmetic for Team Inbox response targets.
 *
 * Two questions, both answered in the policy's IANA time zone:
 *   - `addBusinessMs`: when is a reply due that may take `duration` of
 *     opening time, starting at `start`?
 *   - `businessMsBetween`: how much opening time lies between two instants?
 *
 * A calendar is a weekly schedule (at most one window per weekday) plus a list
 * of closed local dates. `calendar` mode counts every minute and ignores both.
 *
 * Pure and total. The zone math goes through `Intl.DateTimeFormat`, the only
 * correct way to map an instant to a wall clock in an arbitrary zone, and a
 * local wall-clock time back to an instant is resolved against the zone offset
 * at that time, so a window keeps its wall-clock hours across DST. A scan never looks
 * further than {@link MAX_DAYS_SCANNED} local days: a schedule with no opening
 * time in that span yields `null` rather than a loop.
 */

export type SlaHoursMode = 'business' | 'calendar';

export interface SlaBusinessHours {
	/** 0 = Sunday … 6 = Saturday. */
	day: number;
	/** Minutes from local midnight, inclusive. */
	start: number;
	/** Minutes from local midnight, exclusive; up to 1440. */
	end: number;
}

export interface SlaCalendar {
	mode: SlaHoursMode;
	timeZone: string;
	businessHours: readonly SlaBusinessHours[];
	/** Closed local dates, `YYYY-MM-DD`. */
	holidays: readonly string[];
}

/** How far a scan walks before it gives up: a little over a year of local days. */
export const MAX_DAYS_SCANNED = 400;

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
}

/** Whether `timeZone` names a zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
	if (!timeZone) return false;
	try {
		formatterFor(timeZone);
		return true;
	} catch {
		return false;
	}
}

interface LocalDate {
	year: number;
	month: number; // 1-12
	day: number;
}

/** The local calendar date and wall-clock minute of an instant. */
function localParts(instant: number, timeZone: string): LocalDate & { minute: number } {
	const values: Record<string, number> = {};
	for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
		if (part.type !== 'literal') values[part.type] = Number.parseInt(part.value, 10);
	}
	const hour = values['hour'] === 24 ? 0 : (values['hour'] ?? 0);
	return {
		year: values['year'] ?? 1970,
		month: values['month'] ?? 1,
		day: values['day'] ?? 1,
		minute: hour * 60 + (values['minute'] ?? 0),
	};
}

/** Local wall clock minus UTC at `instant`, in ms (seconds dropped). */
function zoneOffsetMs(instant: number, timeZone: string): number {
	const floored = Math.floor(instant / MINUTE_MS) * MINUTE_MS;
	const local = localParts(floored, timeZone);
	return Date.UTC(local.year, local.month - 1, local.day, 0, local.minute) - floored;
}

/**
 * The instant at which the zone's wall clock reads `minute` on `date`. A wall
 * time inside a DST transition (skipped or repeated) resolves to an instant
 * within an hour of it; opening hours rarely sit there.
 */
function zonedInstant(date: LocalDate, minute: number, timeZone: string): number {
	const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minute);
	const first = wall - zoneOffsetMs(wall, timeZone);
	const second = wall - zoneOffsetMs(first, timeZone);
	return Math.min(first, second);
}

function nextDate(date: LocalDate): LocalDate {
	const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
	return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function dateKey(date: LocalDate): string {
	return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function weekday(date: LocalDate): number {
	return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** The opening window of one local date as instants, or null when closed. */
function windowOn(
	date: LocalDate,
	calendar: SlaCalendar,
	holidays: ReadonlySet<string>
): { start: number; end: number } | null {
	if (holidays.has(dateKey(date))) return null;
	const day = weekday(date);
	const hours = calendar.businessHours.find((h) => h.day === day);
	if (!hours || hours.end <= hours.start) return null;
	const start = zonedInstant(date, hours.start, calendar.timeZone);
	const end =
		hours.end >= DAY_MINUTES
			? zonedInstant(nextDate(date), 0, calendar.timeZone)
			: zonedInstant(date, hours.end, calendar.timeZone);
	return end > start ? { start, end } : null;
}

/**
 * When `durationMs` of opening time has elapsed from `startMs`. A start outside
 * the opening hours begins counting at the next opening. `null` when the
 * schedule has no opening time within {@link MAX_DAYS_SCANNED} days.
 */
export function addBusinessMs(
	startMs: number,
	durationMs: number,
	calendar: SlaCalendar
): number | null {
	if (calendar.mode === 'calendar') return startMs + durationMs;
	const holidays = new Set(calendar.holidays);
	let remaining = Math.max(0, durationMs);
	let date: LocalDate = localParts(startMs, calendar.timeZone);
	for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
		const window = windowOn(date, calendar, holidays);
		if (window) {
			const from = Math.max(startMs, window.start);
			if (from < window.end) {
				const available = window.end - from;
				if (remaining <= available) return from + remaining;
				remaining -= available;
			}
		}
		date = nextDate(date);
	}
	return null;
}

/**
 * Opening time between two instants, in ms; 0 when `toMs <= fromMs`. A span
 * longer than {@link MAX_DAYS_SCANNED} days counts its first year only.
 */
export function businessMsBetween(fromMs: number, toMs: number, calendar: SlaCalendar): number {
	if (toMs <= fromMs) return 0;
	if (calendar.mode === 'calendar') return toMs - fromMs;
	const holidays = new Set(calendar.holidays);
	const lastKey = dateKey(localParts(toMs, calendar.timeZone));
	let total = 0;
	let date: LocalDate = localParts(fromMs, calendar.timeZone);
	for (let i = 0; i < MAX_DAYS_SCANNED && dateKey(date) <= lastKey; i++) {
		const window = windowOn(date, calendar, holidays);
		if (window) {
			if (window.start >= toMs) break;
			const overlap = Math.min(toMs, window.end) - Math.max(fromMs, window.start);
			if (overlap > 0) total += overlap;
		}
		date = nextDate(date);
	}
	return total;
}
