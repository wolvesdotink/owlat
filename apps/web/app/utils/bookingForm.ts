/**
 * The booking settings form's shape and its translation to and from what the
 * backend stores: the form edits "HH:MM" strings per weekday (what a time
 * input gives), the backend stores minutes from midnight. An end of "00:00"
 * means midnight at the end of the day. Pure, unit-tested on its own.
 */
import {
	bookingRangeProblem,
	type BookingRangeProblem,
	type BookingTimeRange,
	type BookingWeeklyRange,
} from '@owlat/shared/booking';

export interface FormRange {
	start: string;
	end: string;
}

export interface FormOverride {
	date: string;
	ranges: FormRange[];
}

/** Weekdays in the order the form lists them: Monday first. */
export const FORM_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

export function minutesToTime(minutes: number): string {
	const clamped = minutes >= 24 * 60 ? 0 : minutes;
	return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** "HH:MM" → minutes; `asEnd` reads "00:00" as the end of the day. */
export function timeToMinutes(value: string, asEnd = false): number {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) return Number.NaN;
	const minutes = Number(match[1]) * 60 + Number(match[2]);
	return asEnd && minutes === 0 ? 24 * 60 : minutes;
}

const toRange = (range: FormRange): BookingTimeRange => ({
	startMinute: timeToMinutes(range.start),
	endMinute: timeToMinutes(range.end, true),
});

const fromRange = (range: BookingTimeRange): FormRange => ({
	start: minutesToTime(range.startMinute),
	end: minutesToTime(range.endMinute),
});

/** Monday to Friday, nine to five: what a new page starts with. */
export function defaultWeeklyHours(): Record<number, FormRange[]> {
	const days: Record<number, FormRange[]> = {};
	for (const weekday of FORM_WEEKDAYS) {
		days[weekday] = weekday >= 1 && weekday <= 5 ? [{ start: '09:00', end: '17:00' }] : [];
	}
	return days;
}

export function weeklyFromStored(
	stored: readonly BookingWeeklyRange[]
): Record<number, FormRange[]> {
	const days: Record<number, FormRange[]> = {};
	for (const weekday of FORM_WEEKDAYS) days[weekday] = [];
	for (const range of stored) days[range.weekday]?.push(fromRange(range));
	return days;
}

export function weeklyToStored(days: Record<number, FormRange[]>): BookingWeeklyRange[] {
	return FORM_WEEKDAYS.flatMap((weekday) =>
		(days[weekday] ?? []).map((range) => ({ weekday, ...toRange(range) }))
	);
}

export function overridesFromStored(
	stored: readonly { date: string; ranges: readonly BookingTimeRange[] }[]
): FormOverride[] {
	return stored.map((entry) => ({ date: entry.date, ranges: entry.ranges.map(fromRange) }));
}

export function overridesToStored(
	overrides: readonly FormOverride[]
): { date: string; ranges: BookingTimeRange[] }[] {
	return overrides.map((entry) => ({ date: entry.date, ranges: entry.ranges.map(toRange) }));
}

/** The first problem in a set of form ranges, or `null`; an unfilled time is `bounds`. */
export function formRangeProblem(ranges: readonly FormRange[]): BookingRangeProblem | null {
	const stored = ranges.map(toRange);
	if (stored.some((range) => Number.isNaN(range.startMinute) || Number.isNaN(range.endMinute))) {
		return 'bounds';
	}
	return bookingRangeProblem(stored);
}
