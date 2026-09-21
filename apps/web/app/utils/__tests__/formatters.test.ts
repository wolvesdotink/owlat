import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	capitalize,
	formatDate,
	formatShortDate,
	formatDateTime,
	formatTime,
	formatRelativeTime,
	formatCompactRelativeTime,
	formatNumber,
	formatCompactNumber,
	formatPercentage,
	formatFileSize,
} from '../formatters';

const NOW = new Date(2024, 5, 15, 12, 0, 0); // June 15, 2024 12:00:00
const at = (offsetMs: number) => NOW.getTime() + offsetMs;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function useFrozenClock(date: Date) {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(date);
	});
	afterEach(() => {
		vi.useRealTimers();
	});
}

describe('capitalize', () => {
	it.each([
		['delivered', 'Delivered'],
		['sms', 'Sms'],
		['Delivered', 'Delivered'],
		// Only the first character changes; the rest is never lower-cased.
		['bODY', 'BODY'],
		['a', 'A'],
		['', ''],
	])('%j -> %j', (input, expected) => {
		expect(capitalize(input)).toBe(expected);
	});
});

describe('empty and invalid input', () => {
	it.each([
		['formatDate', formatDate, 'Never', 'Invalid date'],
		['formatShortDate', formatShortDate, 'Never', 'Invalid date'],
		['formatDateTime', formatDateTime, 'Never', 'Invalid date'],
		['formatRelativeTime', formatRelativeTime, 'Never', 'Invalid date'],
		['formatTime', formatTime, '', 'Invalid time'],
	])('%s', (_name, format, empty, invalid) => {
		expect(format(null)).toBe(empty);
		expect(format(undefined)).toBe(empty);
		expect(format('not a date')).toBe(invalid);
	});
});

describe('formatDate', () => {
	const jan15 = new Date(2024, 0, 15);

	it.each([
		['short', ['Jan', '15']],
		['medium', ['Jan', '15', '2024']],
		['long', ['January', '15', '2024']],
		['full', ['Monday', 'January', '15', '2024']],
	] as const)('%s style', (style, parts) => {
		const result = formatDate(jan15, style);
		for (const part of parts) expect(result).toContain(part);
	});

	it('delegates to formatRelativeTime for relative style', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
		expect(formatDate(new Date(2024, 0, 15, 11, 55, 0), 'relative')).toContain('minute');
		vi.useRealTimers();
	});

	it('accepts a timestamp number and an ISO string', () => {
		expect(formatDate(jan15.getTime(), 'medium')).toContain('2024');
		expect(formatDate('2024-01-15T00:00:00.000Z', 'medium')).toContain('2024');
	});
});

describe('formatShortDate', () => {
	useFrozenClock(new Date(2025, 0, 15, 12, 0, 0));

	it('omits the year for a current-year date and appends it for a prior year', () => {
		expect(formatShortDate(new Date(2025, 2, 3))).toBe('Mar 3');
		expect(formatShortDate(new Date(2024, 2, 3))).toBe('Mar 3, 2024');
	});
});

describe('formatDateTime and formatTime', () => {
	it('include a time component', () => {
		const dateTime = formatDateTime(new Date(2024, 0, 15, 14, 30));
		expect(dateTime).toContain('Jan');
		expect(dateTime).toContain('2024');
		expect(dateTime).toMatch(/\d{1,2}:\d{2}/);
		expect(formatTime(new Date(2024, 0, 15, 14, 30))).toMatch(/\d{1,2}:\d{2}/);
	});
});

describe('formatRelativeTime', () => {
	useFrozenClock(NOW);

	it.each([
		// `Intl` owns the wording: sub-minute durations are spoken as seconds and
		// `numeric: 'auto'` reserves "now" for the actual moment.
		[-30_000, '30 seconds ago'],
		[0, 'now'],
		[-5 * MINUTE, '5 minutes ago'],
		[-1 * MINUTE, '1 minute ago'],
		[-3 * HOUR, '3 hours ago'],
		[-1 * HOUR, '1 hour ago'],
		[-2 * DAY, '2 days ago'],
		// Every locale has a word for one day back; the hand-rolled ladder had none.
		[-1 * DAY, 'yesterday'],
		[-14 * DAY, '2 weeks ago'],
		[30_000, 'in 30 seconds'],
		[5 * MINUTE, 'in 5 minutes'],
		[1 * MINUTE, 'in 1 minute'],
		[3 * HOUR, 'in 3 hours'],
		[2 * DAY, 'in 2 days'],
	])('offset %d ms -> %j', (offset, expected) => {
		expect(formatRelativeTime(at(offset))).toBe(expected);
	});

	it.each([
		[new Date(2024, 2, 15, 12, 0, 0), '3 months ago'],
		[new Date(2022, 5, 15, 12, 0, 0), '2 years ago'],
		[new Date(2023, 5, 15, 12, 0, 0), 'last year'],
		// Stays relative far ahead instead of switching to a calendar date: one
		// direction, one vocabulary. Only the COMPACT style falls back to a date.
		[new Date(2025, 0, 15, 12, 0, 0), 'in 7 months'],
	])('%o -> %j', (date, expected) => {
		expect(formatRelativeTime(date)).toBe(expected);
	});
});

describe('formatCompactRelativeTime', () => {
	useFrozenClock(NOW);

	it('returns "Never" for null/undefined by default and honours emptyLabel', () => {
		expect(formatCompactRelativeTime(null)).toBe('Never');
		expect(formatCompactRelativeTime(undefined)).toBe('Never');
		expect(formatCompactRelativeTime(undefined, { emptyLabel: '—' })).toBe('—');
		expect(formatCompactRelativeTime(null, { emptyLabel: 'never used' })).toBe('never used');
	});

	it.each([
		[-30_000, '30s ago'],
		[-5 * MINUTE, '5m ago'],
		// Unit boundaries: minutes up to the hour, hours up to the day, days up to the week.
		[-59 * MINUTE, '59m ago'],
		[-60 * MINUTE, '1h ago'],
		[-3 * HOUR, '3h ago'],
		[-23 * HOUR, '23h ago'],
		// Terse does not mean cryptic: the one word every locale has for the day before.
		[-24 * HOUR, 'yesterday'],
		[-2 * DAY, '2d ago'],
		[-(7 * DAY - 1), '6d ago'],
	])('offset %d ms -> %j', (offset, expected) => {
		expect(formatCompactRelativeTime(at(offset))).toBe(expected);
	});

	it.each([7 * DAY, 10 * DAY])('falls back to a short date from 7 days back (%d ms)', (age) => {
		const result = formatCompactRelativeTime(at(-age));
		expect(result).toContain('Jun');
		expect(result).toMatch(/\d/);
		expect(result).not.toContain('ago');
	});
});

describe('formatNumber', () => {
	it.each([
		[null, '0'],
		[undefined, '0'],
		[0, '0'],
		[42, '42'],
		[1000, '1,000'],
		[1000000, '1,000,000'],
	])('%j -> %j', (input, expected) => {
		expect(formatNumber(input)).toBe(expected);
	});
});

describe('formatCompactNumber', () => {
	it.each([
		[null, /^0$/],
		[undefined, /^0$/],
		[42, /^42$/],
		[1200, /1\.2K/],
		[1000000, /1M/],
	])('%j matches %s', (input, expected) => {
		expect(formatCompactNumber(input)).toMatch(expected);
	});
});

describe('formatPercentage', () => {
	it.each([
		[[null], '0%'],
		[[undefined], '0%'],
		[[0], '0.0%'],
		[[0.5], '50.0%'],
		[[1], '100.0%'],
		[[0.1234, 2], '12.34%'],
		// Percentage mode: the input is already a percentage, not a ratio.
		[[50, 1, false], '50.0%'],
	] as const)('%j -> %j', (args, expected) => {
		expect(formatPercentage(...(args as [number | null | undefined, number?, boolean?]))).toBe(
			expected
		);
	});
});

describe('formatFileSize', () => {
	it.each([
		[[0], '0 Bytes'],
		[[null], '0 Bytes'],
		[[undefined], '0 Bytes'],
		[[500], '500 Bytes'],
		[[1024], '1 KB'],
		[[1048576], '1 MB'],
		[[1073741824], '1 GB'],
		[[1536], '1.5 KB'],
		[[1536, 0], '2 KB'],
		[[1536, 1], '1.5 KB'],
	] as const)('%j -> %j', (args, expected) => {
		expect(formatFileSize(...(args as [number | null | undefined, number?]))).toBe(expected);
	});
});
