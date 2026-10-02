/**
 * Team Inbox response-target policy: input bounds and the stored row's
 * effective view. Pure, so the save mutation and the clock readers share one
 * definition of "a usable policy".
 */

import type { Doc } from '../../_generated/dataModel';
import { isValidTimeZone, type SlaBusinessHours, type SlaHoursMode } from './businessHours';
import type { SlaPolicyView } from './clock';

/** The editable part of a policy (the stored row minus `updatedAt`). */
export interface SlaPolicyInput {
	isEnabled: boolean;
	firstResponseMinutes: number;
	nextResponseMinutes: number;
	hoursMode: SlaHoursMode;
	timeZone: string;
	businessHours: SlaBusinessHours[];
	holidays: string[];
}

/** Targets run from one minute to thirty days. */
const MIN_TARGET_MINUTES = 1;
const MAX_TARGET_MINUTES = 30 * 24 * 60;
const MAX_HOLIDAYS = 200;
const MAX_TIME_ZONE_LENGTH = 64;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(value: string): boolean {
	const match = DATE_PATTERN.exec(value);
	if (!match) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

function isTarget(minutes: number): boolean {
	return (
		Number.isInteger(minutes) && minutes >= MIN_TARGET_MINUTES && minutes <= MAX_TARGET_MINUTES
	);
}

/**
 * Why `input` cannot be saved, or `null` when it can. Opening hours are
 * checked in either mode, so switching back to business hours never finds a
 * broken schedule; they must open at least once a week only in business mode.
 */
export function slaPolicyProblem(input: SlaPolicyInput): string | null {
	if (!isTarget(input.firstResponseMinutes) || !isTarget(input.nextResponseMinutes)) {
		return 'Response targets must be whole minutes between 1 minute and 30 days';
	}
	if (input.timeZone.length > MAX_TIME_ZONE_LENGTH || !isValidTimeZone(input.timeZone)) {
		return 'Unknown time zone';
	}
	const days = new Set<number>();
	for (const hours of input.businessHours) {
		if (!Number.isInteger(hours.day) || hours.day < 0 || hours.day > 6 || days.has(hours.day)) {
			return 'Each weekday can have one opening window';
		}
		days.add(hours.day);
		const { start, end } = hours;
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 * 60) {
			return 'Opening hours must fall within the day';
		}
		if (start >= end) return 'Opening hours must end after they start';
	}
	if (input.hoursMode === 'business' && days.size === 0) {
		return 'Business hours need at least one open day';
	}
	if (input.holidays.length > MAX_HOLIDAYS) return `At most ${MAX_HOLIDAYS} holidays`;
	if (!input.holidays.every(isRealDate)) return 'Holidays must be dates (YYYY-MM-DD)';
	return null;
}

/** The input as it is stored: windows by weekday, holidays sorted and deduplicated. */
export function normalizeSlaPolicy(input: SlaPolicyInput): SlaPolicyInput {
	return {
		...input,
		businessHours: [...input.businessHours].sort((a, b) => a.day - b.day),
		holidays: [...new Set(input.holidays)].sort(),
	};
}

/**
 * The policy the clock runs on, or `null` when targets are off (no row, the
 * switch off, or a row that no longer validates, e.g. a zone this runtime
 * dropped). `null` stops new clocks; it never invents a target.
 */
export function slaPolicyView(row: Doc<'inboxSlaPolicies'> | null): SlaPolicyView | null {
	if (!row || !row.isEnabled || slaPolicyProblem(row) !== null) return null;
	return {
		firstResponseMs: row.firstResponseMinutes * 60_000,
		nextResponseMs: row.nextResponseMinutes * 60_000,
		calendar: {
			mode: row.hoursMode,
			timeZone: row.timeZone,
			businessHours: row.businessHours,
			holidays: row.holidays,
		},
	};
}
