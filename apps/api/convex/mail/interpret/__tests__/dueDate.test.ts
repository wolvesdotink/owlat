/** Deadline phrases resolved deterministically (mail/interpret/dueDate.ts, review F11). */

import { describe, expect, it } from 'vitest';
import { localDayKey, resolveDue, zonedMidnight } from '../dueDate';

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
