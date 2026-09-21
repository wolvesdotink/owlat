/**
 * The RFC 3339 parser (`math.ts`). `Date.parse` is specified only for the
 * ECMAScript Date Time String Format, so every form outside that subset — and
 * every rejection — is pinned here rather than inherited from an engine.
 */

import { describe, expect, it } from 'vitest';
import { daysBetween, isAtOrBefore, parseTimestamp } from '../math.js';

const EPOCH = 0;
const DAY = 86_400_000;

describe('parseTimestamp', () => {
	it('parses the canonical form', () => {
		expect(parseTimestamp('1970-01-01T00:00:00Z')).toBe(EPOCH);
		expect(parseTimestamp('1970-01-02T00:00:00Z')).toBe(DAY);
		expect(parseTimestamp('2026-08-20T00:00:00Z')).toBe(Date.UTC(2026, 7, 20));
	});

	it('accepts the lowercase separator and zone designator', () => {
		expect(parseTimestamp('2026-08-19t00:00:00z')).toBe(parseTimestamp('2026-08-19T00:00:00Z'));
	});

	it('applies numeric offsets, including negative zero', () => {
		expect(parseTimestamp('2026-08-20T05:30:00+05:30')).toBe(
			parseTimestamp('2026-08-20T00:00:00Z')
		);
		expect(parseTimestamp('2026-08-19T19:00:00-05:00')).toBe(
			parseTimestamp('2026-08-20T00:00:00Z')
		);
		expect(parseTimestamp('2026-08-20T00:00:00-00:00')).toBe(
			parseTimestamp('2026-08-20T00:00:00Z')
		);
	});

	it('truncates sub-millisecond digits rather than rounding them', () => {
		expect(parseTimestamp('2026-08-20T00:00:00.123456Z')).toBe(
			(parseTimestamp('2026-08-20T00:00:00Z') as number) + 123
		);
		expect(parseTimestamp('2026-08-20T00:00:00.999999Z')).toBe(
			(parseTimestamp('2026-08-20T00:00:00Z') as number) + 999
		);
		expect(parseTimestamp('2026-08-20T00:00:00.5Z')).toBe(
			(parseTimestamp('2026-08-20T00:00:00Z') as number) + 500
		);
	});

	it('handles leap years and month lengths', () => {
		expect(parseTimestamp('2024-02-29T00:00:00Z')).toBe(Date.UTC(2024, 1, 29));
		expect(parseTimestamp('2100-02-29T00:00:00Z')).toBeUndefined();
		expect(parseTimestamp('2026-02-30T00:00:00Z')).toBeUndefined();
		expect(parseTimestamp('2026-04-31T00:00:00Z')).toBeUndefined();
	});

	it('accepts a leap second as the 61st second of its minute', () => {
		expect(parseTimestamp('2016-12-31T23:59:60Z')).toBe(Date.UTC(2016, 11, 31, 23, 59, 59) + 1_000);
	});

	it('rejects everything that is not RFC 3339', () => {
		for (const bad of [
			'',
			'not a date',
			'2026-08-20',
			'2026-08-20T00:00Z',
			'2026-08-20 00:00:00Z',
			'2026-08-20T00:00:00',
			'2026-08-20T24:00:00Z',
			'2026-08-20T00:60:00Z',
			'2026-13-01T00:00:00Z',
			'2026-08-20T00:00:00+24:00',
			'2026-08-20T00:00:00+05:60',
			'2026-08-20T00:00:00.Z',
			' 2026-08-20T00:00:00Z',
		]) {
			expect(parseTimestamp(bad), bad).toBeUndefined();
		}
	});
});

describe('daysBetween', () => {
	it('measures instants, not strings', () => {
		// The offset-bearing spelling is the earlier instant even though it sorts
		// later lexicographically.
		expect(daysBetween('2020-01-02T00:00:00+05:00', '2020-01-01T23:00:00Z')).toBeGreaterThan(0);
		expect(daysBetween('2020-01-01T23:00:00Z', '2020-01-02T00:00:00+05:00')).toBe(0);
	});

	it('is zero for reversed and for unparseable inputs', () => {
		expect(daysBetween('2026-08-20T00:00:00Z', '2026-08-19T00:00:00Z')).toBe(0);
		expect(daysBetween('yesterday', '2026-08-20T00:00:00Z')).toBe(0);
		expect(daysBetween('2026-08-20T00:00:00Z', 'tomorrow')).toBe(0);
	});

	it('counts fractional days', () => {
		expect(daysBetween('2026-08-19T00:00:00Z', '2026-08-20T12:00:00Z')).toBe(1.5);
	});
});

describe('isAtOrBefore', () => {
	it('is inclusive at the bound and false for unparseable input', () => {
		expect(isAtOrBefore('2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z')).toBe(true);
		expect(isAtOrBefore('2026-08-20T00:00:00.001Z', '2026-08-20T00:00:00Z')).toBe(false);
		expect(isAtOrBefore('2026-08-20T05:30:00+05:30', '2026-08-20T00:00:00Z')).toBe(true);
		expect(isAtOrBefore('whenever', '2026-08-20T00:00:00Z')).toBe(false);
	});
});
