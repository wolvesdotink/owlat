import { describe, expect, it } from 'vitest';
import { computeSlots, isSlotOpen, slotStepMinutes, type AvailabilityRules } from '../slots';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Monday 2026-03-02 00:00 UTC. */
const MONDAY = Date.UTC(2026, 2, 2);

function rules(overrides: Partial<AvailabilityRules> = {}): AvailabilityRules {
	return {
		timeZone: 'UTC',
		weeklyHours: [
			{ weekday: 1, startMinute: 9 * 60, endMinute: 12 * 60 },
			{ weekday: 1, startMinute: 13 * 60, endMinute: 15 * 60 },
		],
		dateOverrides: [],
		minimumNoticeMinutes: 0,
		horizonDays: 30,
		bufferMinutes: 0,
		...overrides,
	};
}

const hours = (slots: number[]) =>
	slots.map((slot) => {
		const d = new Date(slot);
		return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
	});

describe('computeSlots', () => {
	it('steps through each weekly range, leaving room for the whole meeting', () => {
		const slots = computeSlots(rules(), {
			durationMinutes: 60,
			busy: [],
			now: MONDAY - DAY,
			from: MONDAY,
			until: MONDAY + DAY,
		});
		expect(hours(slots)).toEqual([
			'9:00',
			'9:30',
			'10:00',
			'10:30',
			'11:00',
			'13:00',
			'13:30',
			'14:00',
		]);
	});

	it('uses a quarter-hour step for short meetings', () => {
		expect(slotStepMinutes(15)).toBe(15);
		expect(slotStepMinutes(45)).toBe(30);
	});

	it('reads the hours in the host’s zone', () => {
		const slots = computeSlots(rules({ timeZone: 'Europe/Berlin' }), {
			durationMinutes: 60,
			busy: [],
			now: MONDAY - DAY,
			from: MONDAY - 2 * HOUR,
			until: MONDAY + DAY,
		});
		// 09:00 Berlin (CET, UTC+1) is 08:00 UTC.
		expect(hours(slots)[0]).toBe('8:00');
	});

	it('keeps the wall clock across a DST switch', () => {
		// Monday 2026-03-30 is the first Monday after Berlin moved to CEST (UTC+2).
		const after = Date.UTC(2026, 2, 30);
		const slots = computeSlots(rules({ timeZone: 'Europe/Berlin' }), {
			durationMinutes: 60,
			busy: [],
			now: after - DAY,
			from: after - 3 * HOUR,
			until: after + DAY,
		});
		expect(hours(slots)[0]).toBe('7:00');
	});

	it('replaces a weekday with its date override, and an empty one is a day off', () => {
		const special = computeSlots(
			rules({
				dateOverrides: [
					{ date: '2026-03-02', ranges: [{ startMinute: 18 * 60, endMinute: 19 * 60 }] },
				],
			}),
			{ durationMinutes: 30, busy: [], now: MONDAY - DAY, from: MONDAY, until: MONDAY + DAY }
		);
		expect(hours(special)).toEqual(['18:00', '18:30']);
		const off = computeSlots(rules({ dateOverrides: [{ date: '2026-03-02', ranges: [] }] }), {
			durationMinutes: 30,
			busy: [],
			now: MONDAY - DAY,
			from: MONDAY,
			until: MONDAY + DAY,
		});
		expect(off).toEqual([]);
	});

	it('honours the minimum notice and the horizon', () => {
		const noticed = computeSlots(rules({ minimumNoticeMinutes: 90 }), {
			durationMinutes: 30,
			busy: [],
			now: MONDAY + 9 * HOUR,
			until: MONDAY + DAY,
		});
		expect(hours(noticed)[0]).toBe('10:30');
		const nextWeek = computeSlots(rules({ horizonDays: 3 }), {
			durationMinutes: 30,
			busy: [],
			now: MONDAY,
			from: MONDAY + 7 * DAY,
			until: MONDAY + 8 * DAY,
		});
		expect(nextWeek).toEqual([]);
	});

	it('keeps clear of busy time by the buffer on both sides', () => {
		const busy = [{ start: MONDAY + 10 * HOUR, end: MONDAY + 10 * HOUR + 30 * MINUTE }];
		const slots = computeSlots(rules({ bufferMinutes: 15 }), {
			durationMinutes: 30,
			busy,
			now: MONDAY - DAY,
			from: MONDAY,
			until: MONDAY + 12 * HOUR,
		});
		expect(hours(slots)).toEqual(['9:00', '11:00', '11:30']);
	});

	it('stops at the limit and offers nothing for an unknown zone', () => {
		const limited = computeSlots(rules(), {
			durationMinutes: 30,
			busy: [],
			now: MONDAY - DAY,
			limit: 2,
		});
		expect(limited).toHaveLength(2);
		expect(
			computeSlots(rules({ timeZone: 'Mars/Olympus' }), {
				durationMinutes: 30,
				busy: [],
				now: MONDAY,
			})
		).toEqual([]);
	});
});

describe('isSlotOpen', () => {
	it('accepts exactly the offered starts', () => {
		const query = { durationMinutes: 30, busy: [], now: MONDAY - DAY };
		expect(isSlotOpen(rules(), { ...query, start: MONDAY + 9 * HOUR })).toBe(true);
		expect(isSlotOpen(rules(), { ...query, start: MONDAY + 9 * HOUR + 10 * MINUTE })).toBe(false);
		expect(isSlotOpen(rules(), { ...query, start: MONDAY + 12 * HOUR })).toBe(false);
	});
});
