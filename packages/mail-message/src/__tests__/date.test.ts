import { describe, it, expect } from 'vitest';
import { parseDate } from '../parse/date';

const iso = (d: Date | undefined): string | undefined => d?.toISOString();

describe('parseDate — well-formed values', () => {
	it('parses a standard numeric-offset date with a day-of-week', () => {
		expect(iso(parseDate('Tue, 1 Jul 2003 10:52:37 +0200'))).toBe('2003-07-01T08:52:37.000Z');
	});
	it('applies a negative numeric offset', () => {
		expect(iso(parseDate('1 Jul 2003 10:52:37 -0230'))).toBe('2003-07-01T13:22:37.000Z');
	});
	it('defaults missing seconds to zero', () => {
		expect(iso(parseDate('1 Jan 2020 05:30 +0000'))).toBe('2020-01-01T05:30:00.000Z');
	});
	it('treats a missing zone as UTC', () => {
		expect(iso(parseDate('1 Jan 2020 05:30:00'))).toBe('2020-01-01T05:30:00.000Z');
	});
});

describe('parseDate — obsolete named zones', () => {
	it('GMT / UT / UTC / Z are UTC', () => {
		expect(iso(parseDate('Fri, 21 Nov 1997 09:55:06 GMT'))).toBe('1997-11-21T09:55:06.000Z');
		expect(iso(parseDate('21 Nov 1997 09:55:06 UT'))).toBe('1997-11-21T09:55:06.000Z');
		expect(iso(parseDate('21 Nov 1997 09:55:06 Z'))).toBe('1997-11-21T09:55:06.000Z');
	});
	it('EST/EDT/CST/CDT/MST/MDT/PST/PDT offsets', () => {
		expect(iso(parseDate('21 Nov 1997 09:55:06 EST'))).toBe('1997-11-21T14:55:06.000Z');
		expect(iso(parseDate('21 Nov 1997 09:55:06 PDT'))).toBe('1997-11-21T16:55:06.000Z');
	});
	it('an indeterminate single-letter military zone is treated as UTC', () => {
		expect(iso(parseDate('21 Nov 1997 09:55:06 A'))).toBe('1997-11-21T09:55:06.000Z');
	});
});

describe('parseDate — 2- and 3-digit years', () => {
	it('00–49 maps to 2000–2049', () => {
		expect(iso(parseDate('1 Jan 20 00:00:00 +0000'))).toBe('2020-01-01T00:00:00.000Z');
	});
	it('50–99 maps to 1950–1999', () => {
		expect(iso(parseDate('1 Jan 99 00:00:00 +0000'))).toBe('1999-01-01T00:00:00.000Z');
	});
	it('a 3-digit year adds 1900', () => {
		expect(iso(parseDate('5 Oct 100 00:00:00 +0000'))).toBe('2000-10-05T00:00:00.000Z');
	});
});

describe('parseDate — invalid inputs return undefined', () => {
	it.each<[string, string | undefined]>([
		['undefined', undefined],
		['empty', ''],
		['free text', 'not a date at all'],
		['unknown month', '1 Foo 2020 00:00:00 +0000'],
		['impossible calendar date', '31 Feb 2020 00:00:00 +0000'],
		['hour out of range', '1 Jan 2020 25:00:00 +0000'],
		['minute out of range', '1 Jan 2020 00:60:00 +0000'],
		['second out of range', '1 Jan 2020 00:00:61 +0000'],
		['day zero', '0 Jan 2020 00:00:00 +0000'],
		['numeric offset out of range', '1 Jan 2020 00:00:00 +2500'],
		['unknown named zone', '1 Jan 2020 00:00:00 XYZ'],
	])('%s -> undefined', (_label, input) => {
		expect(parseDate(input)).toBeUndefined();
	});
});
