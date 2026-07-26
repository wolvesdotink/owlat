/**
 * P0-5 — the PURE capacity planner as a table, plus the adversarial cases the
 * plan names (zero capacity, unknown horizon, clock skew, empty audience).
 * The predicate is where the correctness of the binding pre-flight lives, so
 * it is tested exhaustively and without any Convex harness (D15).
 */

import { describe, it, expect } from 'vitest';
import { planCampaignCapacity, usableDayCount, MS_PER_DAY, MAX_PLAN_DAYS } from '../capacityPlan';

/** A UTC midnight, so day boundaries in assertions are exact. */
const MIDNIGHT = Date.UTC(2026, 6, 27, 0, 0, 0);
const FOUR_DAYS = 4 * MS_PER_DAY;

describe('usableDayCount', () => {
	it('counts today plus every day that STARTS before the message expires', () => {
		// Queued at midnight with a 4-day horizon: days 0,1,2,3 start before expiry.
		expect(usableDayCount(MIDNIGHT, FOUR_DAYS)).toBe(4);
	});

	it('loses a day when the send starts late in the day', () => {
		const lateEvening = MIDNIGHT + 23 * 60 * 60 * 1000;
		// Expiry lands mid-day-4, so day 4's start still counts: 0..4 = 5 windows.
		expect(usableDayCount(lateEvening, FOUR_DAYS)).toBe(5);
	});

	it('is zero for a non-positive or non-finite horizon', () => {
		expect(usableDayCount(MIDNIGHT, 0)).toBe(0);
		expect(usableDayCount(MIDNIGHT, -1)).toBe(0);
		expect(usableDayCount(MIDNIGHT, Number.NaN)).toBe(0);
		expect(usableDayCount(Number.NaN, FOUR_DAYS)).toBe(0);
	});
});

describe('planCampaignCapacity — the table', () => {
	it('fits comfortably: today alone covers the audience', () => {
		const plan = planCampaignCapacity({
			audienceSize: 100,
			remainingCapacityByDay: [500, 700, 1500],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan).toEqual({ fits: true });
	});

	it('fits exactly on the last day inside the horizon', () => {
		// Horizon = 4 days; capacity 100+100+100+100 = 400 == audience.
		const plan = planCampaignCapacity({
			audienceSize: 400,
			remainingCapacityByDay: [100, 100, 100, 100, 100],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan).toEqual({ fits: true });
	});

	it('misses by one: a single recipient past the horizon refuses with a plan', () => {
		const plan = planCampaignCapacity({
			audienceSize: 401,
			remainingCapacityByDay: [100, 100, 100, 100, 100],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan.fits).toBe(false);
		if (plan.fits) return;
		expect(plan.days).toBe(5);
		expect(plan.slices).toEqual([100, 100, 100, 100, 1]);
		expect(plan.slices.reduce((a, b) => a + b, 0)).toBe(401);
		expect(plan.finishesAt).toBe(MIDNIGHT + 5 * MS_PER_DAY);
	});

	it('zero remaining capacity everywhere: the unplannable sentinel', () => {
		const plan = planCampaignCapacity({
			audienceSize: 1000,
			remainingCapacityByDay: [0, 0, 0],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan).toEqual({ fits: false, days: 0, slices: [], finishesAt: MIDNIGHT });
	});

	it('zero capacity TODAY but growth tomorrow still yields a schedule', () => {
		const plan = planCampaignCapacity({
			audienceSize: 300,
			remainingCapacityByDay: [0, 100, 200, 700],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		// 0 + 100 + 200 = 300 by day 2, inside the 4-day horizon.
		expect(plan).toEqual({ fits: true });
	});

	it('capacity growing across days under the warming schedule', () => {
		const plan = planCampaignCapacity({
			audienceSize: 5000,
			remainingCapacityByDay: [50, 100, 200, 200, 700, 700, 1500, 1500, 3000],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan.fits).toBe(false);
		if (plan.fits) return;
		expect(plan.slices).toEqual([50, 100, 200, 200, 700, 700, 1500, 1500, 50]);
		expect(plan.slices.reduce((a, b) => a + b, 0)).toBe(5000);
		expect(plan.days).toBe(9);
	});

	it('extends past the projection window at the last projected rate', () => {
		const plan = planCampaignCapacity({
			audienceSize: 1000,
			remainingCapacityByDay: [100, 100],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan.fits).toBe(false);
		if (plan.fits) return;
		expect(plan.days).toBe(10);
		expect(plan.slices).toHaveLength(10);
		expect(plan.slices.every((slice) => slice === 100)).toBe(true);
	});

	it('audience smaller than one day of capacity', () => {
		expect(
			planCampaignCapacity({
				audienceSize: 1,
				remainingCapacityByDay: [50],
				maxMessageAgeMs: FOUR_DAYS,
				now: MIDNIGHT,
			})
		).toEqual({ fits: true });
	});

	it('truncates an absurd plan at MAX_PLAN_DAYS', () => {
		const plan = planCampaignCapacity({
			audienceSize: 10_000_000,
			remainingCapacityByDay: [10],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan.fits).toBe(false);
		if (plan.fits) return;
		expect(plan.days).toBe(MAX_PLAN_DAYS);
		expect(plan.slices).toHaveLength(MAX_PLAN_DAYS);
	});
});

describe('planCampaignCapacity — adversarial', () => {
	it('an audience of 0 always fits', () => {
		expect(
			planCampaignCapacity({
				audienceSize: 0,
				remainingCapacityByDay: [0],
				maxMessageAgeMs: FOUR_DAYS,
				now: MIDNIGHT,
			})
		).toEqual({ fits: true });
	});

	it('a hostile audience size never refuses', () => {
		for (const audienceSize of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
			expect(
				planCampaignCapacity({
					audienceSize,
					remainingCapacityByDay: [0],
					maxMessageAgeMs: FOUR_DAYS,
					now: MIDNIGHT,
				})
			).toEqual({ fits: true });
		}
	});

	it('an empty capacity projection is unplannable, never a silent refusal', () => {
		const plan = planCampaignCapacity({
			audienceSize: 10,
			remainingCapacityByDay: [],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan).toEqual({ fits: false, days: 0, slices: [], finishesAt: MIDNIGHT });
	});

	it('NaN / negative / Infinity capacities are treated as zero, not as capacity', () => {
		const plan = planCampaignCapacity({
			audienceSize: 100,
			remainingCapacityByDay: [Number.NaN, -50, Number.POSITIVE_INFINITY, 60],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan.fits).toBe(false);
		if (plan.fits) return;
		expect(plan.slices).toEqual([0, 0, 0, 60, 40]);
	});

	it('a non-finite or non-positive horizon never refuses (unknown, not zero)', () => {
		for (const maxMessageAgeMs of [0, -1, Number.NaN]) {
			expect(
				planCampaignCapacity({
					audienceSize: 1_000_000,
					remainingCapacityByDay: [1],
					maxMessageAgeMs,
					now: MIDNIGHT,
				})
			).toEqual({ fits: true });
		}
	});

	it('clock skew: a clock behind the epoch or NaN never refuses', () => {
		expect(
			planCampaignCapacity({
				audienceSize: 1_000_000,
				remainingCapacityByDay: [1],
				maxMessageAgeMs: FOUR_DAYS,
				now: Number.NaN,
			})
		).toEqual({ fits: true });

		const plan = planCampaignCapacity({
			audienceSize: 1_000_000,
			remainingCapacityByDay: [1],
			maxMessageAgeMs: FOUR_DAYS,
			now: -MS_PER_DAY,
		});
		// A pre-epoch clock still produces a coherent, monotonically later finish.
		expect(plan.fits).toBe(false);
		if (plan.fits) return;
		expect(plan.finishesAt).toBeGreaterThan(-MS_PER_DAY);
	});
});
