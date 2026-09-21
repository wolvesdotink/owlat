import { describe, it, expect } from 'vitest';
import {
	clampMinuteOfDay,
	formatMinuteOfDay,
	isQuietHoursArmed,
	parseMinuteOfDay,
	resolvePostboxQuietHours,
	MINUTES_PER_DAY,
	POSTBOX_QUIET_HOURS_DEFAULT,
	POSTBOX_WEEKDAY_ORDER,
} from '../postboxQuietHours';

describe('clock helpers', () => {
	it('clamps to a real minute of the day', () => {
		expect(clampMinuteOfDay(-5)).toBe(0);
		expect(clampMinuteOfDay(MINUTES_PER_DAY * 3)).toBe(MINUTES_PER_DAY - 1);
		expect(clampMinuteOfDay(90.4)).toBe(90);
		expect(clampMinuteOfDay(Number.NaN)).toBe(0);
	});

	it('round-trips through the HH:MM an <input type="time"> speaks', () => {
		expect(formatMinuteOfDay(0)).toBe('00:00');
		expect(formatMinuteOfDay(7 * 60)).toBe('07:00');
		expect(formatMinuteOfDay(22 * 60 + 5)).toBe('22:05');
		expect(parseMinuteOfDay('22:05')).toBe(22 * 60 + 5);
		expect(parseMinuteOfDay(formatMinuteOfDay(1337))).toBe(1337);
	});

	it('rejects anything that is not a clock time', () => {
		// A half-typed or cleared input must not read as midnight.
		expect(parseMinuteOfDay('')).toBeNull();
		expect(parseMinuteOfDay('7')).toBeNull();
		expect(parseMinuteOfDay('24:00')).toBeNull();
		expect(parseMinuteOfDay('12:60')).toBeNull();
	});
});

describe('resolvePostboxQuietHours', () => {
	it('reads an unset preference as the OFF default', () => {
		expect(resolvePostboxQuietHours(undefined)).toEqual(POSTBOX_QUIET_HOURS_DEFAULT);
		expect(resolvePostboxQuietHours(null)).toEqual(POSTBOX_QUIET_HOURS_DEFAULT);
		expect(resolvePostboxQuietHours(POSTBOX_QUIET_HOURS_DEFAULT).enabled).toBe(false);
	});

	it('keeps a stored window and normalises its mask', () => {
		const resolved = resolvePostboxQuietHours({
			enabled: true,
			startMinute: 1320,
			endMinute: 420,
			days: [5, 1, 5, 9, -1, 2.5],
		});
		expect(resolved).toEqual({ enabled: true, startMinute: 1320, endMinute: 420, days: [1, 5] });
	});

	it('clamps out-of-range minutes rather than trusting them', () => {
		const resolved = resolvePostboxQuietHours({
			enabled: true,
			startMinute: -60,
			endMinute: 99999,
		});
		expect(resolved.startMinute).toBe(0);
		expect(resolved.endMinute).toBe(MINUTES_PER_DAY - 1);
	});
});

describe('isQuietHoursArmed', () => {
	const base = { enabled: true, startMinute: 1320, endMinute: 420, days: [1] };

	it('needs the switch, a weekday and a non-zero span', () => {
		expect(isQuietHoursArmed(base)).toBe(true);
		expect(isQuietHoursArmed({ ...base, enabled: false })).toBe(false);
		expect(isQuietHoursArmed({ ...base, days: [] })).toBe(false);
		expect(isQuietHoursArmed({ ...base, endMinute: base.startMinute })).toBe(false);
	});
});

describe('POSTBOX_WEEKDAY_ORDER', () => {
	it('is Monday-first over every JS weekday value exactly once', () => {
		expect(POSTBOX_WEEKDAY_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0]);
		expect(new Set(POSTBOX_WEEKDAY_ORDER).size).toBe(7);
	});
});
