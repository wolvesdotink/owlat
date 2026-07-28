/**
 * THE BASE SCHEDULE IS A HARD CEILING (plan D19, P3-7).
 *
 * The pace actuator may take a deployment SLOWER than the published warming
 * ramp. It may never take it faster than that ramp's ceiling for the current
 * day, whatever the dial says — and the cap never grows beyond the volume that
 * has actually been exercised against it, because an unexercised cap is not
 * evidence that a bigger one is safe.
 *
 * The ceiling is asserted against the REAL published schedule
 * (`getWarmingCapForDay`), not a stand-in: a suite that invented its own ramp
 * could pass while the shipped one was exceeded.
 */

import { describe, expect, it } from 'vitest';
import { getWarmingCapForDay } from '@owlat/shared/warming';
import { effectiveDailyCap } from '../paceCeiling';
import { PACE_AIMD } from '../paceConfig';

describe('effectiveDailyCap — the published schedule bounds every day', () => {
	it('never exceeds the day’s published cap, at any multiplier', () => {
		for (let day = 1; day <= 30; day += 1) {
			const baseScheduleCap = getWarmingCapForDay(day);
			if (!Number.isFinite(baseScheduleCap)) continue;
			for (const multiplier of [1, 1.25, PACE_AIMD.multiplierCeiling, 99]) {
				const cap = effectiveDailyCap({ baseScheduleCap, multiplier });
				expect(cap).toBeLessThanOrEqual(baseScheduleCap);
			}
		}
	});

	it('goes SLOWER than the published ramp when the dial retreats', () => {
		const cap = effectiveDailyCap({ baseScheduleCap: 1_000, multiplier: 0.5 });
		expect(cap).toBe(500);
	});

	it('a graduated IP has no ceiling to apply, so none is invented', () => {
		expect(effectiveDailyCap({ baseScheduleCap: Infinity, multiplier: 1 })).toBe(Infinity);
	});
});

describe('effectiveDailyCap — the cap never outgrows exercised volume', () => {
	it('bounds growth by what volume actually exercised the cap', () => {
		const cap = effectiveDailyCap({
			baseScheduleCap: 1_000,
			multiplier: PACE_AIMD.multiplierCeiling,
			exercisedVolume: 100,
		});
		expect(cap).toBe(Math.floor(100 * PACE_AIMD.exerciseHeadroom));
		expect(cap).toBeLessThan(1_000);
	});

	it('the exercise bound has a floor, so a quiet day cannot strand the cell', () => {
		const cap = effectiveDailyCap({
			baseScheduleCap: 1_000,
			multiplier: 1,
			exercisedVolume: 1,
		});
		expect(cap).toBe(PACE_AIMD.minimumDailyCap);
	});

	it('ABSENCE of a volume reading is not a constraint (plan D2)', () => {
		expect(effectiveDailyCap({ baseScheduleCap: 1_000, multiplier: 1 })).toBe(1_000);
		expect(
			effectiveDailyCap({ baseScheduleCap: 1_000, multiplier: 1, exercisedVolume: undefined })
		).toBe(1_000);
	});

	it('the schedule ceiling still wins over a generous exercise bound', () => {
		const cap = effectiveDailyCap({
			baseScheduleCap: 500,
			multiplier: PACE_AIMD.multiplierCeiling,
			exercisedVolume: 10_000,
		});
		expect(cap).toBe(500);
	});
});

describe('effectiveDailyCap — degenerate input', () => {
	it('an unreadable base cap yields the policy minimum, never NaN or zero', () => {
		for (const baseScheduleCap of [Number.NaN, 0, -5]) {
			expect(effectiveDailyCap({ baseScheduleCap, multiplier: 1 })).toBe(PACE_AIMD.minimumDailyCap);
		}
	});

	it('an unreadable multiplier falls back to the published schedule, unmodified', () => {
		expect(effectiveDailyCap({ baseScheduleCap: 200, multiplier: Number.NaN })).toBe(200);
	});

	it('never returns zero — a cap of nothing can never be re-measured', () => {
		const cap = effectiveDailyCap({
			baseScheduleCap: 1,
			multiplier: PACE_AIMD.multiplierFloor,
			exercisedVolume: 1,
		});
		expect(cap).toBeGreaterThanOrEqual(1);
	});
});
