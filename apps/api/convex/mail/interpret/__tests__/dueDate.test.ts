/** Deadline phrases resolved deterministically (mail/interpret/dueDate.ts, review F11). */

import { describe, expect, it } from 'vitest';
import { localDayKey, resolveDue, zonedMidnight, zonedTime } from '../dueDate';

/** Wednesday 7 October 2026, 09:00 UTC. */
const SENT = Date.UTC(2026, 9, 7, 9, 0);
const BERLIN = 'Europe/Berlin';
const day = (y: number, m: number, d: number, tz = BERLIN) => zonedMidnight({ y, m, d }, tz);

describe('resolveDue', () => {
	it.each([
		['by Friday', day(2026, 10, 9)],
		['bis Freitag', day(2026, 10, 9)],
		['avant vendredi', day(2026, 10, 9)],
		['tomorrow', day(2026, 10, 8)],
		['bis morgen', day(2026, 10, 8)],
		['today', day(2026, 10, 7)],
		['übermorgen', day(2026, 10, 9)],
		['in 3 days', day(2026, 10, 10)],
		['innerhalb von 3 Tagen', day(2026, 10, 10)],
		['dans 3 jours', day(2026, 10, 10)],
		['in a week', day(2026, 10, 14)],
		['by 2026-10-20', day(2026, 10, 20)],
		['bis 20.10.2026', day(2026, 10, 20)],
		['bis zum 20.10.', day(2026, 10, 20)],
		['by October 20', day(2026, 10, 20)],
		['by 20 October 2026', day(2026, 10, 20)],
		['bis 20. Oktober', day(2026, 10, 20)],
		['avant le 20 octobre', day(2026, 10, 20)],
		['by 25/10/2026', day(2026, 10, 25)],
		['by January 5', day(2027, 1, 5)],
	])('reads "%s"', (phrase, at) => {
		expect(resolveDue(phrase, SENT, BERLIN)).toEqual({ at, isAmbiguous: false });
	});

	it.each([
		'next Friday',
		'by Wednesday', // the message's own weekday: today or in a week?
		'by 9/10', // 9 October or September 10th?
		'soon',
		'before the launch',
		'by Friday or Monday',
		'by 31.02.2026',
	])('keeps "%s" as written, ambiguous, with no date', (phrase) => {
		expect(resolveDue(phrase, SENT, BERLIN)).toEqual({ isAmbiguous: true });
	});

	it('resolves in the owner time zone', () => {
		const ny = resolveDue('by Friday', SENT, 'America/New_York');
		expect(ny.at).toBe(Date.UTC(2026, 9, 9, 4));
		expect(localDayKey(ny.at as number, 'America/New_York')).toBe('2026-10-09');
		expect(localDayKey(day(2026, 10, 9), BERLIN)).toBe('2026-10-09');
	});

	it('falls back to UTC for an unknown zone', () => {
		expect(resolveDue('tomorrow', SENT, 'Not/AZone')).toEqual({
			at: Date.UTC(2026, 9, 8),
			isAmbiguous: false,
		});
	});
});

describe('times of day (review round 2 F8)', () => {
	const at = (h: number, min = 0, tz = BERLIN) =>
		zonedTime({ y: 2026, m: 10, d: 9 }, h * 60 + min, tz);
	it.each([
		['by Friday at 17:00', at(17)],
		['by Friday 5pm', at(17)],
		['by Friday, 5:30 p.m.', at(17, 30)],
		['bis Freitag 17 Uhr', at(17)],
		['bis Freitag, 17.30 Uhr', at(17, 30)],
		['avant vendredi 17h', at(17)],
		['vendredi 17h30', at(17, 30)],
		['Friday noon', at(12)],
		['by Friday 15:00 UTC', at(15, 0, 'UTC')],
	])('reads "%s" with its time', (phrase, expected) => {
		expect(resolveDue(phrase, SENT, BERLIN)).toEqual({ at: expected, isAmbiguous: false });
	});

	it('reads a time without a date as today, unless it already passed', () => {
		expect(resolveDue('by 5pm', SENT, BERLIN)).toEqual({
			at: zonedTime({ y: 2026, m: 10, d: 7 }, 17 * 60, BERLIN),
			isAmbiguous: false,
		});
		expect(resolveDue('by 8am', SENT, BERLIN)).toEqual({ isAmbiguous: true });
	});

	it.each([
		'by Friday afternoon',
		'Freitag nachmittag',
		'vendredi soir',
		'tonight',
		'by Friday 5pm PST',
		'by Friday 17:00 CET',
		'by Friday 17:00 or 18:00',
		'by Friday 25:00',
	])('keeps "%s" ambiguous without a date', (phrase) => {
		expect(resolveDue(phrase, SENT, BERLIN)).toEqual({ isAmbiguous: true });
	});

	it('still reads dates written with dots and dashes', () => {
		expect(resolveDue('bis 20.10.2026', SENT, BERLIN).at).toBe(day(2026, 10, 20));
		expect(resolveDue('by 2026-10-20', SENT, BERLIN).at).toBe(day(2026, 10, 20));
		expect(resolveDue('la date limite est vendredi', SENT, BERLIN).at).toBe(day(2026, 10, 9));
	});
});
