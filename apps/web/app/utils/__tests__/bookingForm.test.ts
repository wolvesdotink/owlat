/**
 * The booking settings form's translation (utils/bookingForm): "HH:MM" strings
 * to stored minutes and back, midnight as the end of a day, and the first
 * problem in a day's ranges.
 */
import { describe, expect, it } from 'vitest';
import {
	defaultWeeklyHours,
	formRangeProblem,
	minutesToTime,
	overridesFromStored,
	overridesToStored,
	timeToMinutes,
	weeklyFromStored,
	weeklyToStored,
} from '../bookingForm';

describe('bookingForm', () => {
	it('reads 00:00 as the end of the day only for an end time', () => {
		expect(timeToMinutes('00:00')).toBe(0);
		expect(timeToMinutes('00:00', true)).toBe(24 * 60);
		expect(timeToMinutes('9:30')).toBe(570);
		expect(timeToMinutes('')).toBeNaN();
		expect(minutesToTime(24 * 60)).toBe('00:00');
		expect(minutesToTime(570)).toBe('09:30');
	});

	it('round-trips weekly hours and date overrides', () => {
		const weekly = [
			{ weekday: 1, startMinute: 540, endMinute: 720 },
			{ weekday: 1, startMinute: 780, endMinute: 1020 },
			{ weekday: 0, startMinute: 600, endMinute: 24 * 60 },
		];
		const form = weeklyFromStored(weekly);
		expect(form[1]).toEqual([
			{ start: '09:00', end: '12:00' },
			{ start: '13:00', end: '17:00' },
		]);
		expect(form[6]).toEqual([]);
		// Stored Monday first, Sunday last, the order the form lists them.
		expect(weeklyToStored(form)).toEqual([weekly[0], weekly[1], weekly[2]]);

		const overrides = [
			{ date: '2026-03-03', ranges: [] },
			{ date: '2026-03-04', ranges: [{ startMinute: 600, endMinute: 660 }] },
		];
		expect(overridesToStored(overridesFromStored(overrides))).toEqual(overrides);
	});

	it('starts a new page on weekdays, nine to five', () => {
		const days = defaultWeeklyHours();
		expect(days[1]).toEqual([{ start: '09:00', end: '17:00' }]);
		expect(days[0]).toEqual([]);
		expect(days[6]).toEqual([]);
	});

	it('names the first problem in a day', () => {
		expect(formRangeProblem([{ start: '09:00', end: '17:00' }])).toBeNull();
		expect(formRangeProblem([{ start: '09:00', end: '' }])).toBe('bounds');
		expect(formRangeProblem([{ start: '17:00', end: '09:00' }])).toBe('order');
		expect(
			formRangeProblem([
				{ start: '09:00', end: '12:00' },
				{ start: '11:00', end: '13:00' },
			])
		).toBe('overlap');
		expect(formRangeProblem([{ start: '22:00', end: '00:00' }])).toBeNull();
	});
});
