/**
 * Timezone-aware working-hours window (lib/workingHours.ts).
 *
 * Pure logic, no Convex harness. Covers:
 *   - disabled/unset → always allowed (24/7 default preserved);
 *   - a same-day window holds an out-of-hours (3am) instant and admits a
 *     mid-day instant, evaluated in the CONFIGURED timezone (not the runner's);
 *   - weekday restriction (a weekend instant is out even at noon);
 *   - an overnight window that wraps past midnight;
 *   - an invalid timezone throws (caller fails safe).
 */
import { describe, it, expect } from 'vitest';
import { isWithinWorkingHours } from '../lib/workingHours';

// A fixed instant we can reason about: 2026-07-06 is a Monday.
// 14:00 UTC.
const MON_1400_UTC = Date.UTC(2026, 6, 6, 14, 0, 0);
// 03:00 UTC Monday.
const MON_0300_UTC = Date.UTC(2026, 6, 6, 3, 0, 0);
// 12:00 UTC Saturday (2026-07-04 is a Saturday).
const SAT_1200_UTC = Date.UTC(2026, 6, 4, 12, 0, 0);

describe('isWithinWorkingHours', () => {
	it('is always within when the window is disabled/unset (24/7 default)', () => {
		expect(isWithinWorkingHours({}, MON_0300_UTC)).toBe(true);
		expect(isWithinWorkingHours({ workingHoursEnabled: false }, MON_0300_UTC)).toBe(true);
	});

	it('admits a mid-day instant and HOLDS a 3am instant for a Mon–Fri 09:00–17:00 UTC window', () => {
		const cfg = {
			workingHoursEnabled: true,
			workingHoursTimezone: 'UTC',
			workingHoursStart: 9 * 60,
			workingHoursEnd: 17 * 60,
			workingHoursDays: [1, 2, 3, 4, 5],
		};
		expect(isWithinWorkingHours(cfg, MON_1400_UTC)).toBe(true);
		expect(isWithinWorkingHours(cfg, MON_0300_UTC)).toBe(false);
	});

	it('evaluates the window in the configured timezone, not the runner clock', () => {
		// 14:00 UTC is 09:00 in New York (UTC-5 in July → actually UTC-4 DST → 10:00).
		// Use a window that only passes when interpreted in New York local time.
		const cfg = {
			workingHoursEnabled: true,
			workingHoursTimezone: 'America/New_York',
			workingHoursStart: 9 * 60,
			workingHoursEnd: 17 * 60,
			workingHoursDays: [1, 2, 3, 4, 5],
		};
		// 14:00 UTC Monday = 10:00 EDT Monday → inside 09:00–17:00.
		expect(isWithinWorkingHours(cfg, MON_1400_UTC)).toBe(true);
		// 03:00 UTC Monday = 23:00 EDT SUNDAY → outside the window AND not a work day.
		expect(isWithinWorkingHours(cfg, MON_0300_UTC)).toBe(false);
	});

	it('holds a weekend instant even during business hours', () => {
		const cfg = {
			workingHoursEnabled: true,
			workingHoursTimezone: 'UTC',
			workingHoursStart: 9 * 60,
			workingHoursEnd: 17 * 60,
			workingHoursDays: [1, 2, 3, 4, 5],
		};
		expect(isWithinWorkingHours(cfg, SAT_1200_UTC)).toBe(false);
	});

	it('supports an overnight window that wraps past midnight (22:00–06:00)', () => {
		const cfg = {
			workingHoursEnabled: true,
			workingHoursTimezone: 'UTC',
			workingHoursStart: 22 * 60,
			workingHoursEnd: 6 * 60,
			workingHoursDays: [1, 2, 3, 4, 5], // window starts on a weekday
		};
		// 03:00 Monday is inside the tail of Sunday-night's window? No — Sunday is
		// not a work day, so the Monday-morning tail (belonging to Sunday's start)
		// is excluded.
		expect(isWithinWorkingHours(cfg, MON_0300_UTC)).toBe(false);
		// 23:00 Monday UTC is inside the evening segment on a work day.
		const MON_2300_UTC = Date.UTC(2026, 6, 6, 23, 0, 0);
		expect(isWithinWorkingHours(cfg, MON_2300_UTC)).toBe(true);
		// 03:00 Tuesday is the tail of Monday-night's window → allowed.
		const TUE_0300_UTC = Date.UTC(2026, 6, 7, 3, 0, 0);
		expect(isWithinWorkingHours(cfg, TUE_0300_UTC)).toBe(true);
	});

	it('throws on an invalid timezone so the caller can fail safe (hold for review)', () => {
		const cfg = {
			workingHoursEnabled: true,
			workingHoursTimezone: 'Not/AZone',
			workingHoursStart: 9 * 60,
			workingHoursEnd: 17 * 60,
		};
		expect(() => isWithinWorkingHours(cfg, MON_1400_UTC)).toThrow();
	});
});
