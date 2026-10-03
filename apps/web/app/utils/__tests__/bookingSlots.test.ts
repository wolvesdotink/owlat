import { describe, expect, it } from 'vitest';
import {
	availabilityHtml,
	calendarWeeks,
	groupSlotsByDay,
	monthWindow,
	zonedDateKey,
} from '../bookingSlots';
import {
	defaultWeeklyHours,
	formRangeProblem,
	overridesToStored,
	timeToMinutes,
	weeklyFromStored,
	weeklyToStored,
} from '../bookingForm';

describe('booking slots in the viewer’s zone', () => {
	it('groups instants by the local day they fall on', () => {
		// 23:30 UTC on Mar 2 is already Mar 3 in Berlin.
		const late = Date.UTC(2026, 2, 2, 23, 30);
		const early = Date.UTC(2026, 2, 2, 9, 0);
		expect(zonedDateKey(late, 'UTC')).toBe('2026-03-02');
		expect(zonedDateKey(late, 'Europe/Berlin')).toBe('2026-03-03');
		const days = groupSlotsByDay([late, early], 'Europe/Berlin');
		expect([...days.keys()]).toEqual(['2026-03-02', '2026-03-03']);
	});

	it('spans a month from local midnight to local midnight', () => {
		const { from, until } = monthWindow(2026, 12, 'Europe/Berlin');
		expect(from).toBe(Date.UTC(2026, 10, 30, 23, 0));
		expect(until).toBe(Date.UTC(2026, 11, 31, 23, 0));
	});

	it('lays a month out in whole Monday-first weeks', () => {
		const weeks = calendarWeeks(2026, 3);
		expect(weeks.every((week) => week.length === 7)).toBe(true);
		// March 1, 2026 is a Sunday: six days of February lead in.
		expect(weeks[0]!.map((cell) => cell.inMonth)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			true,
		]);
		expect(weeks[0]![6]!.key).toBe('2026-03-01');
	});

	it('builds the composer block with escaped copy and the link', () => {
		const html = availabilityHtml(
			{
				title: 'Intro',
				durationMinutes: 30,
				timeZone: 'UTC',
				url: 'https://owlat.example.com/book/ada/intro?x=<1>',
				slots: [Date.UTC(2026, 2, 3, 10, 0)],
			},
			{ intro: 'Times that work <for me>:', linkLead: 'Or pick one:' },
			'en-US'
		);
		expect(html).toContain('<li>Tue, Mar 3, 10:00 AM – 10:30 AM</li>');
		expect(html).toContain('Times that work &lt;for me&gt;:');
		expect(html).toContain('href="https://owlat.example.com/book/ada/intro?x=&lt;1&gt;"');
	});
});

describe('booking form ranges', () => {
	it('round-trips weekly hours and reads 00:00 as the end of the day', () => {
		const weekly = defaultWeeklyHours();
		weekly[6] = [{ start: '22:00', end: '00:00' }];
		const stored = weeklyToStored(weekly);
		expect(stored).toContainEqual({ weekday: 6, startMinute: 1320, endMinute: 1440 });
		expect(stored.filter((range) => range.weekday === 1)).toEqual([
			{ weekday: 1, startMinute: 540, endMinute: 1020 },
		]);
		expect(weeklyFromStored(stored)[6]).toEqual([{ start: '22:00', end: '00:00' }]);
		expect(timeToMinutes('nope')).toBeNaN();
	});

	it('flags empty, inverted and overlapping ranges', () => {
		expect(formRangeProblem([{ start: '09:00', end: '' }])).toBe('bounds');
		expect(formRangeProblem([{ start: '12:00', end: '09:00' }])).toBe('order');
		expect(
			formRangeProblem([
				{ start: '09:00', end: '12:00' },
				{ start: '11:00', end: '13:00' },
			])
		).toBe('overlap');
		expect(overridesToStored([{ date: '2026-12-24', ranges: [] }])).toEqual([
			{ date: '2026-12-24', ranges: [] },
		]);
	});
});
