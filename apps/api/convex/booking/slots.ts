/**
 * Booking page availability: which start times a guest may pick.
 *
 * Pure (no Convex, no clock), so the page read, the booking mutation's
 * re-validation and the composer's "Insert availability" all answer from the
 * same function, and the tests drive it with fixed instants.
 *
 * The host's hours are wall-clock minutes in THEIR zone; every slot comes out as
 * an absolute instant (epoch ms), which the guest's browser shows in the
 * guest's zone. A local date's ranges are its date override when one exists
 * (an empty override is a day off), else that weekday's weekly hours. Each range
 * is converted once at its start and end, and slots step through it in absolute
 * time, so a range that spans a DST switch keeps its true length.
 */

import { getTzParts, wallClockToEpoch } from '@owlat/shared/ical';
import type { BookingTimeRange, BookingWeeklyRange } from '@owlat/shared/booking';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The host's rules, as stored on `bookingProfiles`. */
export interface AvailabilityRules {
	timeZone: string;
	weeklyHours: readonly BookingWeeklyRange[];
	dateOverrides: readonly { date: string; ranges: readonly BookingTimeRange[] }[];
	minimumNoticeMinutes: number;
	horizonDays: number;
	bufferMinutes: number;
}

/** A busy stretch (an existing booking), epoch ms, half-open [start, end). */
export interface BusyInterval {
	start: number;
	end: number;
}

/**
 * How far apart offered start times are: a quarter hour for short meetings,
 * half an hour otherwise, so a day of 30-minute calls reads 9:00, 9:30, 10:00.
 */
export function slotStepMinutes(durationMinutes: number): number {
	return durationMinutes < 30 ? 15 : 30;
}

/** `YYYY-MM-DD` for a calendar day. */
function dateKey(year: number, month: number, day: number): string {
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The ranges open on one local date: its override, else its weekday's hours. */
function rangesFor(
	rules: AvailabilityRules,
	key: string,
	weekday: number
): readonly BookingTimeRange[] {
	const override = rules.dateOverrides.find((entry) => entry.date === key);
	if (override) return override.ranges;
	return rules.weeklyHours.filter((range) => range.weekday === weekday);
}

function overlapsBusy(
	start: number,
	end: number,
	busy: readonly BusyInterval[],
	bufferMs: number
): boolean {
	for (const interval of busy) {
		if (start < interval.end + bufferMs && end > interval.start - bufferMs) return true;
	}
	return false;
}

/** The earliest and latest start a guest may pick at `now`. */
export function bookableWindow(
	rules: Pick<AvailabilityRules, 'minimumNoticeMinutes' | 'horizonDays'>,
	now: number
): { earliest: number; latest: number } {
	return {
		earliest: now + rules.minimumNoticeMinutes * MINUTE_MS,
		latest: now + rules.horizonDays * DAY_MS,
	};
}

export interface SlotQuery {
	durationMinutes: number;
	busy: readonly BusyInterval[];
	now: number;
	/** Only starts at or after this instant (defaults to the earliest bookable). */
	from?: number;
	/** Only starts before this instant (defaults to the end of the horizon). */
	until?: number;
	/** Stop after this many slots. */
	limit?: number;
}

/**
 * Every open start time (epoch ms, ascending) for a meeting of
 * `durationMinutes`: inside the host's hours, past the minimum notice, within
 * the booking horizon, and clear of every busy interval by the buffer on both
 * sides. An unknown time zone yields no slots rather than wrong ones.
 */
export function computeSlots(rules: AvailabilityRules, query: SlotQuery): number[] {
	const { earliest, latest } = bookableWindow(rules, query.now);
	const from = Math.max(earliest, query.from ?? earliest);
	const until = Math.min(latest + 1, query.until ?? latest + 1);
	if (from >= until || query.durationMinutes <= 0) return [];
	const durationMs = query.durationMinutes * MINUTE_MS;
	const stepMs = slotStepMinutes(query.durationMinutes) * MINUTE_MS;
	const bufferMs = rules.bufferMinutes * MINUTE_MS;
	const limit = query.limit ?? Number.POSITIVE_INFINITY;

	let first: ReturnType<typeof getTzParts>;
	try {
		// A day early: a range on the previous local date can still end after `from`.
		first = getTzParts(from - DAY_MS, rules.timeZone);
	} catch {
		return [];
	}
	const dayCount = Math.ceil((until - from) / DAY_MS) + 2;
	const slots: number[] = [];
	for (let offset = 0; offset <= dayCount && slots.length < limit; offset++) {
		const calendar = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
		const year = calendar.getUTCFullYear();
		const month = calendar.getUTCMonth() + 1;
		const day = calendar.getUTCDate();
		const ranges = [...rangesFor(rules, dateKey(year, month, day), calendar.getUTCDay())].sort(
			(a, b) => a.startMinute - b.startMinute
		);
		for (const range of ranges) {
			const rangeStart = wallClockToEpoch(
				year,
				month,
				day,
				Math.floor(range.startMinute / 60),
				range.startMinute % 60,
				rules.timeZone
			);
			const rangeEnd =
				range.endMinute >= 24 * 60
					? wallClockToEpoch(year, month, day + 1, 0, 0, rules.timeZone)
					: wallClockToEpoch(
							year,
							month,
							day,
							Math.floor(range.endMinute / 60),
							range.endMinute % 60,
							rules.timeZone
						);
			for (let start = rangeStart; start + durationMs <= rangeEnd; start += stepMs) {
				if (start < from) continue;
				if (start >= until) break;
				if (overlapsBusy(start, start + durationMs, query.busy, bufferMs)) continue;
				slots.push(start);
				if (slots.length >= limit) break;
			}
			if (slots.length >= limit) break;
		}
	}
	return slots;
}

/** Whether `start` is one of the slots {@link computeSlots} would offer now. */
export function isSlotOpen(
	rules: AvailabilityRules,
	query: Omit<SlotQuery, 'from' | 'until' | 'limit'> & { start: number }
): boolean {
	const found = computeSlots(rules, { ...query, from: query.start, until: query.start + 1 });
	return found.length === 1 && found[0] === query.start;
}
