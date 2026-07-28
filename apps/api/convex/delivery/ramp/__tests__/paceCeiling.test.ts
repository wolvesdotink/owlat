/**
 * THE BASE SCHEDULE IS A HARD CEILING (plan D19, P3-7).
 *
 * The pace actuator may take a deployment SLOWER than the published warming
 * ramp. It may never take it faster than that ramp's ceiling for the current
 * day, whatever the dial says — and the cap never grows beyond the volume that
 * has actually been exercised against it, because an unexercised cap is not
 * evidence that a bigger one is safe.
 *
 * TWO CAPS APPEAR IN THE FORMULA and these fixtures keep them apart, because
 * conflating them is what made an earlier revision's whole increase range inert:
 * the dial multiplies the per-(IP x mailboxProvider) CELL cap, and the IP's
 * PUBLISHED schedule cap is the ceiling that clamps the result.
 *
 * The ceiling is asserted against the REAL published schedule
 * (`getWarmingCapForDay`), not a stand-in: a suite that invented its own ramp
 * could pass while the shipped one was exceeded.
 */

import { describe, expect, it } from 'vitest';
import { getWarmingCapForDay } from '@owlat/shared/warming';
import { effectiveDailyCap } from '../paceCeiling';
import { PACE_AIMD } from '../paceConfig';

/** A per-provider narrowing: the cell cap sits BELOW the IP's published cap. */
const PROVIDER_SPLIT = 0.5;

describe('effectiveDailyCap — the published schedule bounds every day', () => {
	it('never exceeds the day’s published cap, at any multiplier', () => {
		for (let day = 1; day <= 30; day += 1) {
			const baseScheduleCap = getWarmingCapForDay(day);
			if (!Number.isFinite(baseScheduleCap)) continue;
			for (const multiplier of [1, 1.25, PACE_AIMD.multiplierCeiling, 99]) {
				const cap = effectiveDailyCap({
					cellCap: baseScheduleCap * PROVIDER_SPLIT,
					baseScheduleCap,
					multiplier,
				});
				expect(cap).toBeLessThanOrEqual(baseScheduleCap);
			}
		}
	});

	it('the dial BUYS per-provider headroom below the IP’s published cap', () => {
		// The whole point of M_MAX: a cell narrowed to half the IP's cap can be
		// asked to carry more, and the answer is a real, different number.
		const cap = effectiveDailyCap({ cellCap: 500, baseScheduleCap: 1_000, multiplier: 1.5 });
		expect(cap).toBe(750);
	});

	it('a retreat from a raised dial costs the full multiplicative decrease', () => {
		const raised = effectiveDailyCap({ cellCap: 500, baseScheduleCap: 1_000, multiplier: 1.5 });
		const halved = effectiveDailyCap({ cellCap: 500, baseScheduleCap: 1_000, multiplier: 0.75 });
		expect(halved).toBe(Math.floor(raised / 2));
	});

	it('goes SLOWER than the published ramp when the dial retreats', () => {
		const cap = effectiveDailyCap({ cellCap: 1_000, baseScheduleCap: 1_000, multiplier: 0.5 });
		expect(cap).toBe(500);
	});

	it('a graduated IP has no ceiling to apply, so none is invented', () => {
		expect(effectiveDailyCap({ cellCap: Infinity, baseScheduleCap: Infinity, multiplier: 1 })).toBe(
			Infinity
		);
	});
});

describe('effectiveDailyCap — the cap never outgrows exercised volume', () => {
	it('bounds growth by what volume actually exercised the cap', () => {
		const cap = effectiveDailyCap({
			cellCap: 1_000,
			baseScheduleCap: 1_000,
			multiplier: PACE_AIMD.multiplierCeiling,
			exercisedVolume: 100,
		});
		expect(cap).toBe(150);
		expect(cap).toBeLessThan(1_000);
	});

	it('the exercise bound has a floor, so a quiet day cannot strand the cell', () => {
		const cap = effectiveDailyCap({
			cellCap: 1_000,
			baseScheduleCap: 1_000,
			multiplier: 1,
			exercisedVolume: 1,
		});
		expect(cap).toBe(50);
	});

	it('ABSENCE of a volume reading is not a constraint (plan D2)', () => {
		expect(effectiveDailyCap({ cellCap: 1_000, baseScheduleCap: 1_000, multiplier: 1 })).toBe(
			1_000
		);
		expect(
			effectiveDailyCap({
				cellCap: 1_000,
				baseScheduleCap: 1_000,
				multiplier: 1,
				exercisedVolume: undefined,
			})
		).toBe(1_000);
	});

	it('the schedule ceiling still wins over a generous exercise bound', () => {
		const cap = effectiveDailyCap({
			cellCap: 500,
			baseScheduleCap: 500,
			multiplier: PACE_AIMD.multiplierCeiling,
			exercisedVolume: 10_000,
		});
		expect(cap).toBe(500);
	});
});

describe('effectiveDailyCap — degenerate input', () => {
	it('an unreadable cell cap yields the policy minimum, never NaN or zero', () => {
		for (const cellCap of [Number.NaN, 0, -5]) {
			expect(effectiveDailyCap({ cellCap, baseScheduleCap: 1_000, multiplier: 1 })).toBe(50);
		}
	});

	it('an unreadable published ceiling does not pin the cell to the minimum', () => {
		// A ceiling we cannot read is not a ceiling; the cell cap still governs.
		for (const baseScheduleCap of [Number.NaN, 0, -5]) {
			expect(effectiveDailyCap({ cellCap: 800, baseScheduleCap, multiplier: 1 })).toBe(800);
		}
	});

	it('an unreadable multiplier falls back to the cell cap, unmodified', () => {
		expect(
			effectiveDailyCap({ cellCap: 200, baseScheduleCap: 1_000, multiplier: Number.NaN })
		).toBe(200);
	});

	it('never returns zero — a cap of nothing can never be re-measured', () => {
		const cap = effectiveDailyCap({
			cellCap: 1,
			baseScheduleCap: 1,
			multiplier: PACE_AIMD.multiplierFloor,
			exercisedVolume: 1,
		});
		expect(cap).toBeGreaterThanOrEqual(1);
	});
});
