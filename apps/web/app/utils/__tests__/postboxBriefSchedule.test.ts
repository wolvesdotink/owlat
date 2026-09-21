/**
 * Daily-brief delivery time (idea 29). The rejection path is the point: an
 * unparseable time must leave the stored schedule alone, not silently move a
 * 07:00 brief to midnight.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_BRIEF_TIME_DEFAULT_MINUTE,
	minuteToTimeInput,
	timeInputToMinute,
} from '../postboxBriefSchedule';

describe('minuteToTimeInput', () => {
	it('renders zero-padded local wall-clock time', () => {
		expect(minuteToTimeInput(0)).toBe('00:00');
		expect(minuteToTimeInput(POSTBOX_BRIEF_TIME_DEFAULT_MINUTE)).toBe('07:00');
		expect(minuteToTimeInput(23 * 60 + 5)).toBe('23:05');
	});

	it('clamps a stored value that is out of range', () => {
		expect(minuteToTimeInput(-30)).toBe('00:00');
		expect(minuteToTimeInput(5000)).toBe('23:59');
	});
});

describe('timeInputToMinute', () => {
	it('parses what the time input produces', () => {
		expect(timeInputToMinute('07:00')).toBe(420);
		expect(timeInputToMinute('23:59')).toBe(1439);
		// Some browsers append seconds.
		expect(timeInputToMinute('07:30:00')).toBe(450);
	});

	it('rejects rather than guessing', () => {
		for (const bad of ['', 'morning', '25:00', '07:60', '7', '--:--']) {
			expect(timeInputToMinute(bad)).toBeNull();
		}
	});

	it('round-trips every minute of the day', () => {
		for (let minute = 0; minute < 1440; minute += 7) {
			expect(timeInputToMinute(minuteToTimeInput(minute))).toBe(minute);
		}
	});
});
