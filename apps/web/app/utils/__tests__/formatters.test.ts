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

describe('capitalize', () => {
	it('upper-cases the first character and leaves the rest untouched', () => {
		expect(capitalize('delivered')).toBe('Delivered');
		expect(capitalize('sms')).toBe('Sms');
	});

	it('leaves an already-capitalized string unchanged', () => {
		expect(capitalize('Delivered')).toBe('Delivered');
	});

	it('does not lower-case the remaining characters', () => {
		expect(capitalize('bODY')).toBe('BODY');
	});

	it('handles a single-character string', () => {
		expect(capitalize('a')).toBe('A');
	});

	it('returns an empty string unchanged', () => {
		expect(capitalize('')).toBe('');
	});
});

describe('formatDate', () => {
	it('returns "Never" for null', () => {
		expect(formatDate(null)).toBe('Never');
	});

	it('returns "Never" for undefined', () => {
		expect(formatDate(undefined)).toBe('Never');
	});

	it('returns "Invalid date" for invalid input', () => {
		expect(formatDate('not a date')).toBe('Invalid date');
	});

	it('formats with short style', () => {
		const result = formatDate(new Date(2024, 0, 15), 'short');
		expect(result).toContain('Jan');
		expect(result).toContain('15');
	});

	it('formats with medium style (default)', () => {
		const result = formatDate(new Date(2024, 0, 15), 'medium');
		expect(result).toContain('Jan');
		expect(result).toContain('15');
		expect(result).toContain('2024');
	});

	it('formats with long style', () => {
		const result = formatDate(new Date(2024, 0, 15), 'long');
		expect(result).toContain('January');
		expect(result).toContain('15');
		expect(result).toContain('2024');
	});

	it('formats with full style', () => {
		const result = formatDate(new Date(2024, 0, 15), 'full');
		expect(result).toContain('Monday');
		expect(result).toContain('January');
		expect(result).toContain('15');
		expect(result).toContain('2024');
	});

	it('delegates to formatRelativeTime for relative style', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
		const result = formatDate(new Date(2024, 0, 15, 11, 55, 0), 'relative');
		expect(result).toContain('minute');
		vi.useRealTimers();
	});

	it('accepts timestamp number', () => {
		const timestamp = new Date(2024, 0, 15).getTime();
		const result = formatDate(timestamp, 'medium');
		expect(result).toContain('2024');
	});

	it('accepts ISO string', () => {
		const result = formatDate('2024-01-15T00:00:00.000Z', 'medium');
		expect(result).toContain('2024');
	});
});

describe('formatShortDate', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2025, 0, 15, 12, 0, 0)); // Jan 15, 2025
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns "Never" for null', () => {
		expect(formatShortDate(null)).toBe('Never');
	});

	it('returns "Never" for undefined', () => {
		expect(formatShortDate(undefined)).toBe('Never');
	});

	it('returns "Invalid date" for invalid input', () => {
		expect(formatShortDate('not a date')).toBe('Invalid date');
	});

	it('omits the year for a current-year date', () => {
		const result = formatShortDate(new Date(2025, 2, 3));
		expect(result).toBe('Mar 3');
	});

	it('appends the year for a prior-year date', () => {
		const result = formatShortDate(new Date(2024, 2, 3));
		expect(result).toBe('Mar 3, 2024');
	});
});

describe('formatDateTime', () => {
	it('returns "Never" for null', () => {
		expect(formatDateTime(null)).toBe('Never');
	});

	it('returns "Never" for undefined', () => {
		expect(formatDateTime(undefined)).toBe('Never');
	});

	it('returns "Invalid date" for invalid input', () => {
		expect(formatDateTime('not a date')).toBe('Invalid date');
	});

	it('includes time in output', () => {
		const result = formatDateTime(new Date(2024, 0, 15, 14, 30));
		expect(result).toContain('Jan');
		expect(result).toContain('15');
		expect(result).toContain('2024');
		// Should contain time component
		expect(result).toMatch(/\d{1,2}:\d{2}/);
	});
});

describe('formatTime', () => {
	it('returns empty string for null', () => {
		expect(formatTime(null)).toBe('');
	});

	it('returns empty string for undefined', () => {
		expect(formatTime(undefined)).toBe('');
	});

	it('returns "Invalid time" for invalid input', () => {
		expect(formatTime('not a date')).toBe('Invalid time');
	});

	it('formats time correctly', () => {
		const result = formatTime(new Date(2024, 0, 15, 14, 30));
		expect(result).toMatch(/\d{1,2}:\d{2}/);
	});
});

describe('formatRelativeTime', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2024, 5, 15, 12, 0, 0)); // June 15, 2024 12:00:00
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns "Never" for null', () => {
		expect(formatRelativeTime(null)).toBe('Never');
	});

	it('returns "Never" for undefined', () => {
		expect(formatRelativeTime(undefined)).toBe('Never');
	});

	it('returns "Invalid date" for invalid input', () => {
		expect(formatRelativeTime('not a date')).toBe('Invalid date');
	});

	it('says the seconds rather than a vague "just now"', () => {
		// `Intl` owns the wording now; sub-minute durations are spoken as
		// seconds, and `numeric: 'auto'` reserves "now" for the actual moment.
		const date = new Date(2024, 5, 15, 11, 59, 30);
		expect(formatRelativeTime(date)).toBe('30 seconds ago');
		expect(formatRelativeTime(new Date(2024, 5, 15, 12, 0, 0))).toBe('now');
	});

	it('returns minutes ago', () => {
		const date = new Date(2024, 5, 15, 11, 55, 0);
		expect(formatRelativeTime(date)).toBe('5 minutes ago');
	});

	it('returns singular minute', () => {
		const date = new Date(2024, 5, 15, 11, 59, 0);
		expect(formatRelativeTime(date)).toBe('1 minute ago');
	});

	it('returns hours ago', () => {
		const date = new Date(2024, 5, 15, 9, 0, 0);
		expect(formatRelativeTime(date)).toBe('3 hours ago');
	});

	it('returns singular hour', () => {
		const date = new Date(2024, 5, 15, 11, 0, 0);
		expect(formatRelativeTime(date)).toBe('1 hour ago');
	});

	it('returns days ago', () => {
		const date = new Date(2024, 5, 13, 12, 0, 0);
		expect(formatRelativeTime(date)).toBe('2 days ago');
	});

	it('uses the locale word for a day back, not "1 day ago"', () => {
		// The point of `numeric: 'auto'`: every locale has a word for this and
		// the hand-rolled ladder could produce none of them.
		const date = new Date(2024, 5, 14, 12, 0, 0);
		expect(formatRelativeTime(date)).toBe('yesterday');
	});

	it('returns weeks ago', () => {
		const date = new Date(2024, 5, 1, 12, 0, 0);
		expect(formatRelativeTime(date)).toBe('2 weeks ago');
	});

	it('returns months ago', () => {
		const date = new Date(2024, 2, 15, 12, 0, 0); // March
		expect(formatRelativeTime(date)).toBe('3 months ago');
	});

	it('returns years ago', () => {
		const date = new Date(2022, 5, 15, 12, 0, 0);
		expect(formatRelativeTime(date)).toBe('2 years ago');
	});

	it('uses the locale word for a year back', () => {
		const date = new Date(2023, 5, 15, 12, 0, 0);
		expect(formatRelativeTime(date)).toBe('last year');
	});

	// Future dates
	it('says how many seconds ahead, not "in a few seconds"', () => {
		const date = new Date(2024, 5, 15, 12, 0, 30);
		expect(formatRelativeTime(date)).toBe('in 30 seconds');
	});

	it('returns "in X minutes" for future minutes', () => {
		const date = new Date(2024, 5, 15, 12, 5, 0);
		expect(formatRelativeTime(date)).toBe('in 5 minutes');
	});

	it('returns "in 1 minute" for singular future minute', () => {
		const date = new Date(2024, 5, 15, 12, 1, 0);
		expect(formatRelativeTime(date)).toBe('in 1 minute');
	});

	it('returns "in X hours" for future hours', () => {
		const date = new Date(2024, 5, 15, 15, 0, 0);
		expect(formatRelativeTime(date)).toBe('in 3 hours');
	});

	it('returns "in X days" for future days', () => {
		const date = new Date(2024, 5, 17, 12, 0, 0);
		expect(formatRelativeTime(date)).toBe('in 2 days');
	});

	it('stays relative for a far-future date instead of switching to a calendar', () => {
		// The old ladder gave up past a week ahead and printed "Jan 15, 2025",
		// so a scheduled send seven months out read as a date with no sense of
		// distance. One direction, one vocabulary; the COMPACT style is the one
		// that falls back to a date, and only for the past.
		const date = new Date(2025, 0, 15, 12, 0, 0);
		expect(formatRelativeTime(date)).toBe('in 7 months');
	});
});

describe('formatCompactRelativeTime', () => {
	const NOW = new Date(2024, 5, 15, 12, 0, 0); // June 15, 2024 12:00:00

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns "Never" for null/undefined by default', () => {
		expect(formatCompactRelativeTime(null)).toBe('Never');
		expect(formatCompactRelativeTime(undefined)).toBe('Never');
	});

	it('honors a custom emptyLabel for null/undefined', () => {
		expect(formatCompactRelativeTime(undefined, { emptyLabel: '—' })).toBe('—');
		expect(formatCompactRelativeTime(null, { emptyLabel: 'never used' })).toBe('never used');
	});

	it('is terse under a minute', () => {
		expect(formatCompactRelativeTime(NOW.getTime() - 30_000)).toBe('30s ago');
	});

	it('formats minutes compactly', () => {
		expect(formatCompactRelativeTime(NOW.getTime() - 5 * 60_000)).toBe('5m ago');
	});

	it('stays in minutes right up to the hour boundary', () => {
		expect(formatCompactRelativeTime(NOW.getTime() - 59 * 60_000)).toBe('59m ago');
		expect(formatCompactRelativeTime(NOW.getTime() - 60 * 60_000)).toBe('1h ago');
	});

	it('formats hours compactly', () => {
		expect(formatCompactRelativeTime(NOW.getTime() - 3 * 3_600_000)).toBe('3h ago');
	});

	it('stays in hours right up to the day boundary', () => {
		expect(formatCompactRelativeTime(NOW.getTime() - 23 * 3_600_000)).toBe('23h ago');
	});

	it('says "yesterday" rather than "1d ago"', () => {
		// Terse does not mean cryptic: `numeric: 'auto'` keeps the one word every
		// locale has for the day before, even in the narrow style.
		expect(formatCompactRelativeTime(NOW.getTime() - 24 * 3_600_000)).toBe('yesterday');
	});

	it('formats days compactly', () => {
		expect(formatCompactRelativeTime(NOW.getTime() - 2 * 86_400_000)).toBe('2d ago');
	});

	it('stays in days right up to the week boundary', () => {
		expect(formatCompactRelativeTime(NOW.getTime() - (7 * 86_400_000 - 1))).toBe('6d ago');
	});

	it('falls back to a short date at exactly 7 days', () => {
		const result = formatCompactRelativeTime(NOW.getTime() - 7 * 86_400_000);
		expect(result).toContain('Jun');
		expect(result).not.toContain('ago');
	});

	it('falls back to a short date past 7 days', () => {
		const result = formatCompactRelativeTime(NOW.getTime() - 10 * 86_400_000);
		expect(result).toContain('Jun');
		expect(result).toMatch(/\d/);
		expect(result).not.toContain('ago');
	});
});

describe('formatNumber', () => {
	it('returns "0" for null', () => {
		expect(formatNumber(null)).toBe('0');
	});

	it('returns "0" for undefined', () => {
		expect(formatNumber(undefined)).toBe('0');
	});

	it('formats thousands with separator', () => {
		expect(formatNumber(1000)).toBe('1,000');
	});

	it('formats millions', () => {
		expect(formatNumber(1000000)).toBe('1,000,000');
	});

	it('formats small numbers without separator', () => {
		expect(formatNumber(42)).toBe('42');
	});

	it('formats zero', () => {
		expect(formatNumber(0)).toBe('0');
	});
});

describe('formatCompactNumber', () => {
	it('returns "0" for null', () => {
		expect(formatCompactNumber(null)).toBe('0');
	});

	it('returns "0" for undefined', () => {
		expect(formatCompactNumber(undefined)).toBe('0');
	});

	it('formats thousands as K', () => {
		const result = formatCompactNumber(1200);
		expect(result).toMatch(/1\.2K/);
	});

	it('formats millions as M', () => {
		const result = formatCompactNumber(1000000);
		expect(result).toMatch(/1M/);
	});

	it('does not compact small numbers', () => {
		expect(formatCompactNumber(42)).toBe('42');
	});
});

describe('formatPercentage', () => {
	it('returns "0%" for null', () => {
		expect(formatPercentage(null)).toBe('0%');
	});

	it('returns "0%" for undefined', () => {
		expect(formatPercentage(undefined)).toBe('0%');
	});

	it('converts decimal to percentage (default mode)', () => {
		expect(formatPercentage(0.5)).toBe('50.0%');
	});

	it('formats with specified decimals', () => {
		expect(formatPercentage(0.1234, 2)).toBe('12.34%');
	});

	it('handles percentage mode (not decimal)', () => {
		expect(formatPercentage(50, 1, false)).toBe('50.0%');
	});

	it('formats zero', () => {
		expect(formatPercentage(0)).toBe('0.0%');
	});

	it('formats 100%', () => {
		expect(formatPercentage(1)).toBe('100.0%');
	});
});

describe('formatFileSize', () => {
	it('returns "0 Bytes" for 0', () => {
		expect(formatFileSize(0)).toBe('0 Bytes');
	});

	it('returns "0 Bytes" for null', () => {
		expect(formatFileSize(null)).toBe('0 Bytes');
	});

	it('returns "0 Bytes" for undefined', () => {
		expect(formatFileSize(undefined)).toBe('0 Bytes');
	});

	it('formats bytes', () => {
		expect(formatFileSize(500)).toBe('500 Bytes');
	});

	it('formats KB', () => {
		expect(formatFileSize(1024)).toBe('1 KB');
	});

	it('formats MB', () => {
		expect(formatFileSize(1048576)).toBe('1 MB');
	});

	it('formats GB', () => {
		expect(formatFileSize(1073741824)).toBe('1 GB');
	});

	it('formats fractional sizes', () => {
		expect(formatFileSize(1536)).toBe('1.5 KB');
	});

	it('respects decimal places', () => {
		expect(formatFileSize(1536, 0)).toBe('2 KB');
		expect(formatFileSize(1536, 1)).toBe('1.5 KB');
	});
});
