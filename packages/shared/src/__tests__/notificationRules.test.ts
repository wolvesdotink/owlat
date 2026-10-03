import { describe, expect, it } from 'vitest';
import {
	decideNotification,
	isQuietAt,
	isValidTimeZone,
	localClockIn,
	minutesUntilQuietEnd,
	resolveNotifyAbout,
	resolveQuietHours,
	type QuietHours,
} from '../notificationRules';

const NIGHT: QuietHours = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60, days: [5] };

describe('localClockIn', () => {
	// Friday 2026-10-02 21:30 UTC.
	const at = Date.UTC(2026, 9, 2, 21, 30);

	it('reads the wall clock in the device zone, across a day boundary', () => {
		expect(localClockIn('UTC', at)).toEqual({ minuteOfDay: 21 * 60 + 30, weekday: 5 });
		// Berlin is UTC+2 in October: 23:30 the same Friday.
		expect(localClockIn('Europe/Berlin', at)).toEqual({ minuteOfDay: 23 * 60 + 30, weekday: 5 });
		// Kiritimati is UTC+14: already 11:30 on Saturday.
		expect(localClockIn('Pacific/Kiritimati', at)).toEqual({
			minuteOfDay: 11 * 60 + 30,
			weekday: 6,
		});
	});

	it('reads an absent or unknown zone as UTC rather than throwing', () => {
		expect(localClockIn(undefined, at)).toEqual(localClockIn('UTC', at));
		expect(localClockIn('Mars/Olympus', at)).toEqual(localClockIn('UTC', at));
	});
});

describe('isQuietAt / minutesUntilQuietEnd', () => {
	it('covers the night after the masked start day, wrapping midnight', () => {
		expect(isQuietAt(NIGHT, { minuteOfDay: 23 * 60, weekday: 5 })).toBe(true);
		expect(isQuietAt(NIGHT, { minuteOfDay: 3 * 60, weekday: 6 })).toBe(true);
		expect(isQuietAt(NIGHT, { minuteOfDay: 3 * 60, weekday: 5 })).toBe(false);
		expect(isQuietAt(NIGHT, { minuteOfDay: 12 * 60, weekday: 5 })).toBe(false);
	});

	it('never suppresses with an inert window', () => {
		expect(isQuietAt({ ...NIGHT, enabled: false }, { minuteOfDay: 23 * 60, weekday: 5 })).toBe(
			false
		);
		expect(isQuietAt(undefined, { minuteOfDay: 23 * 60, weekday: 5 })).toBe(false);
	});

	it('counts the minutes left in the window, across midnight', () => {
		expect(minutesUntilQuietEnd(NIGHT, { minuteOfDay: 23 * 60, weekday: 5 })).toBe(8 * 60);
		expect(minutesUntilQuietEnd(NIGHT, { minuteOfDay: 6 * 60 + 30, weekday: 6 })).toBe(30);
		expect(minutesUntilQuietEnd(NIGHT, { minuteOfDay: 12 * 60, weekday: 5 })).toBeNull();
	});
});

describe('decideNotification', () => {
	it('applies mute, reply alert, scope and quiet hours in that order', () => {
		expect(decideNotification({ setting: 'everything', muted: true, alerted: true })).toEqual({
			fire: false,
			suppressed: 'muted',
		});
		expect(decideNotification({ setting: 'nothing', alerted: true, quiet: true }).fire).toBe(true);
		expect(
			decideNotification({ setting: 'people-important', category: 'newsletter' }).suppressed
		).toBe('scope');
		expect(decideNotification({ setting: 'people-important' }).fire).toBe(true);
		expect(decideNotification({ setting: 'everything', quiet: true }).suppressed).toBe(
			'quiet-hours'
		);
	});
});

describe('normalisation', () => {
	it('defaults the scope by whether categories exist', () => {
		expect(resolveNotifyAbout(undefined, true)).toBe('people-important');
		expect(resolveNotifyAbout('bogus', false)).toBe('everything');
		expect(resolveNotifyAbout('nothing', true)).toBe('nothing');
	});

	it('cleans a stored window', () => {
		expect(
			resolveQuietHours({ enabled: true, startMinute: 99999, endMinute: -4, days: [9, 1, 1] })
		).toEqual({
			enabled: true,
			startMinute: 1439,
			endMinute: 0,
			days: [1],
		});
	});

	it('recognises an IANA zone', () => {
		expect(isValidTimeZone('Europe/Berlin')).toBe(true);
		expect(isValidTimeZone('Mars/Olympus')).toBe(false);
	});
});
