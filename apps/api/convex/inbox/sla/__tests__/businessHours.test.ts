/**
 * Business-hours arithmetic behind the Team Inbox reply deadlines.
 */
import { describe, expect, it } from 'vitest';
import {
	addBusinessMs,
	businessMsBetween,
	isValidTimeZone,
	type SlaCalendar,
} from '../businessHours';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Mon–Fri 09:00–17:00 in the given zone. */
function weekdays(timeZone: string, extra: Partial<SlaCalendar> = {}): SlaCalendar {
	return {
		mode: 'business',
		timeZone,
		businessHours: [1, 2, 3, 4, 5].map((day) => ({ day, start: 9 * 60, end: 17 * 60 })),
		holidays: [],
		...extra,
	};
}

const utc = (iso: string) => Date.parse(iso);

describe('addBusinessMs', () => {
	it('adds plain time in calendar mode', () => {
		const start = utc('2026-10-03T22:00:00Z'); // a Saturday night
		expect(addBusinessMs(start, 4 * HOUR, { ...weekdays('UTC'), mode: 'calendar' })).toBe(
			start + 4 * HOUR
		);
	});

	it('counts within the same opening window', () => {
		// Thursday 2026-10-01 10:00 UTC + 4h → 14:00.
		expect(addBusinessMs(utc('2026-10-01T10:00:00Z'), 4 * HOUR, weekdays('UTC'))).toBe(
			utc('2026-10-01T14:00:00Z')
		);
	});

	it('carries the rest over to the next opening', () => {
		// Thursday 15:00 + 4h → 2h on Thursday, 2h on Friday → Friday 11:00.
		expect(addBusinessMs(utc('2026-10-01T15:00:00Z'), 4 * HOUR, weekdays('UTC'))).toBe(
			utc('2026-10-02T11:00:00Z')
		);
	});

	it('starts counting at the next opening for a message that lands at night or on a weekend', () => {
		// Friday 20:00 → Monday 09:00 + 30m.
		expect(addBusinessMs(utc('2026-10-02T20:00:00Z'), 30 * MINUTE, weekdays('UTC'))).toBe(
			utc('2026-10-05T09:30:00Z')
		);
	});

	it('skips closed dates', () => {
		const calendar = weekdays('UTC', { holidays: ['2026-10-05'] });
		expect(addBusinessMs(utc('2026-10-02T20:00:00Z'), 30 * MINUTE, calendar)).toBe(
			utc('2026-10-06T09:30:00Z')
		);
	});

	it('reads the opening hours in the policy time zone', () => {
		// 09:00 in Berlin (CEST, UTC+2) is 07:00 UTC.
		expect(addBusinessMs(utc('2026-10-01T05:00:00Z'), HOUR, weekdays('Europe/Berlin'))).toBe(
			utc('2026-10-01T08:00:00Z')
		);
	});

	it('keeps the wall-clock opening across a DST change', () => {
		// Berlin leaves summer time on Sunday 2026-10-25: Monday 09:00 is 08:00 UTC.
		expect(addBusinessMs(utc('2026-10-23T20:00:00Z'), HOUR, weekdays('Europe/Berlin'))).toBe(
			utc('2026-10-26T09:00:00Z')
		);
	});

	it('treats an end of 1440 as midnight', () => {
		const calendar: SlaCalendar = {
			...weekdays('UTC'),
			businessHours: [{ day: 4, start: 22 * 60, end: 24 * 60 }],
		};
		// Thursday 23:30 + 1h → 30m Thursday, then next Thursday 22:30.
		expect(addBusinessMs(utc('2026-10-01T23:30:00Z'), HOUR, calendar)).toBe(
			utc('2026-10-08T22:30:00Z')
		);
	});

	it('gives up on a schedule with no opening time', () => {
		expect(addBusinessMs(0, HOUR, weekdays('UTC', { businessHours: [] }))).toBeNull();
	});
});

describe('businessMsBetween', () => {
	it('is the inverse of addBusinessMs', () => {
		const calendar = weekdays('Europe/Berlin', { holidays: ['2026-10-05'] });
		const start = utc('2026-10-01T13:17:00Z');
		const due = addBusinessMs(start, 11 * HOUR + 7 * MINUTE, calendar)!;
		expect(businessMsBetween(start, due, calendar)).toBe(11 * HOUR + 7 * MINUTE);
	});

	it('counts nothing outside the opening hours', () => {
		expect(
			businessMsBetween(utc('2026-10-02T17:00:00Z'), utc('2026-10-05T09:00:00Z'), weekdays('UTC'))
		).toBe(0);
	});

	it('is zero for a reversed span and plain time in calendar mode', () => {
		expect(businessMsBetween(10, 5, weekdays('UTC'))).toBe(0);
		expect(businessMsBetween(0, 5 * HOUR, { ...weekdays('UTC'), mode: 'calendar' })).toBe(5 * HOUR);
	});
});

describe('isValidTimeZone', () => {
	it('accepts IANA names and rejects the rest', () => {
		expect(isValidTimeZone('Europe/Berlin')).toBe(true);
		expect(isValidTimeZone('UTC')).toBe(true);
		expect(isValidTimeZone('Mars/Olympus')).toBe(false);
		expect(isValidTimeZone('')).toBe(false);
	});
});
