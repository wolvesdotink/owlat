/**
 * Unit selection for relative times — the only part of "2 hours ago" that is a
 * product decision rather than a fact about a language. The words come from
 * `Intl.RelativeTimeFormat`; what is tested here is which unit it is handed,
 * and the boundaries where that unit changes.
 */
import { describe, expect, it } from 'vitest';
import { compactRelativeTime, isSameYear, relativeTimeParts } from '../relativeTime';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTimeParts', () => {
	it('reduces a duration to the largest unit that does not lie', () => {
		// 90 seconds is "1 minute", not "90 seconds"; 40 days is "1 month".
		expect(relativeTimeParts(NOW - 90 * SECOND, NOW)).toEqual({ value: -1, unit: 'minute' });
		expect(relativeTimeParts(NOW - 40 * DAY, NOW)).toEqual({ value: -1, unit: 'month' });
	});

	it('keeps the sign, so one code path serves both directions', () => {
		// The hand-rolled version had two ladders, one of which had drifted:
		// past dates fell back to a calendar past a week and future dates did
		// not, for no reason anyone could name.
		expect(relativeTimeParts(NOW - 3 * HOUR, NOW)).toEqual({ value: -3, unit: 'hour' });
		expect(relativeTimeParts(NOW + 3 * HOUR, NOW)).toEqual({ value: 3, unit: 'hour' });
	});

	it('switches unit exactly at each boundary', () => {
		expect(relativeTimeParts(NOW - 59 * SECOND, NOW).unit).toBe('second');
		expect(relativeTimeParts(NOW - MINUTE, NOW).unit).toBe('minute');
		expect(relativeTimeParts(NOW - 59 * MINUTE, NOW).unit).toBe('minute');
		expect(relativeTimeParts(NOW - HOUR, NOW).unit).toBe('hour');
		expect(relativeTimeParts(NOW - 23 * HOUR, NOW).unit).toBe('hour');
		expect(relativeTimeParts(NOW - DAY, NOW).unit).toBe('day');
		expect(relativeTimeParts(NOW - 6 * DAY, NOW).unit).toBe('day');
		expect(relativeTimeParts(NOW - 7 * DAY, NOW).unit).toBe('week');
		expect(relativeTimeParts(NOW - 29 * DAY, NOW).unit).toBe('week');
		expect(relativeTimeParts(NOW - 30 * DAY, NOW).unit).toBe('month');
		expect(relativeTimeParts(NOW - 364 * DAY, NOW).unit).toBe('month');
		expect(relativeTimeParts(NOW - 365 * DAY, NOW).unit).toBe('year');
	});

	it('reports the exact moment as zero seconds', () => {
		// `Intl`'s `numeric: 'auto'` turns this into "now" — which is the one
		// case a threshold ladder had to special-case by hand.
		expect(relativeTimeParts(NOW, NOW)).toEqual({ value: 0, unit: 'second' });
	});

	it('truncates rather than rounds, so nothing is announced early', () => {
		// 119 minutes is "1 hour ago", not "2 hours ago": a row must never claim
		// more elapsed time than has elapsed.
		expect(relativeTimeParts(NOW - 119 * MINUTE, NOW)).toEqual({ value: -1, unit: 'hour' });
	});
});

describe('compactRelativeTime', () => {
	it('stays relative inside a week', () => {
		expect(compactRelativeTime(NOW - 6 * DAY, NOW)).toEqual({
			kind: 'relative',
			parts: { value: -6, unit: 'day' },
		});
	});

	it('hands back to a calendar date at a week', () => {
		// Past a week "31 days ago" stops answering "when was this?".
		expect(compactRelativeTime(NOW - 7 * DAY, NOW)).toEqual({
			kind: 'date',
			at: NOW - 7 * DAY,
		});
	});

	it('keeps a future timestamp relative however far out it is', () => {
		// The cutoff is about a fading memory of the past; nothing about "in 3
		// weeks" is improved by printing a date instead.
		expect(compactRelativeTime(NOW + 30 * DAY, NOW).kind).toBe('relative');
	});
});

describe('isSameYear', () => {
	it('is true inside the current calendar year', () => {
		expect(isSameYear(Date.UTC(2026, 0, 1, 12), NOW)).toBe(true);
		expect(isSameYear(Date.UTC(2026, 11, 31, 12), NOW)).toBe(true);
	});

	it('is false across a year boundary, however close', () => {
		// A day apart, and the short date has to grow a year — otherwise a list
		// spanning New Year shows two rows dated "Dec 31" and "Jan 1" with no
		// way to tell which is which.
		expect(isSameYear(Date.UTC(2025, 11, 31, 12), NOW)).toBe(false);
	});
});
