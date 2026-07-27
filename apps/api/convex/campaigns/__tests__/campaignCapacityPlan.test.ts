/**
 * P0-5 — the PURE capacity planner as a table, plus the adversarial cases the
 * plan names (zero capacity, unknown horizon, clock skew, empty audience).
 * The predicate is where the correctness of the binding pre-flight lives, so
 * it is tested exhaustively and without any Convex harness (D15).
 */

import { describe, it, expect } from 'vitest';
import {
	buildCapacitySchedule,
	planCampaignCapacity,
	usableDayCount,
	MS_PER_DAY,
	MAX_PLAN_DAYS,
} from '../capacityPlan';

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
		expect(plan).toEqual({
			fits: false,
			days: 0,
			slices: [],
			finishesAt: MIDNIGHT,
			covered: 0,
			truncated: false,
			audienceUnderCounted: false,
		});
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
		// The plan does NOT reach everyone, and says so rather than letting the
		// caller quote `days` as a finish date (D14 honesty).
		expect(plan.truncated).toBe(true);
		expect(plan.covered).toBe(10 * MAX_PLAN_DAYS);
		expect(plan.covered).toBeLessThan(10_000_000);
	});

	it('a schedule that reaches everyone is never marked truncated', () => {
		const plan = planCampaignCapacity({
			audienceSize: 401,
			remainingCapacityByDay: [100, 100, 100, 100, 100],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan.fits).toBe(false);
		if (plan.fits) return;
		expect(plan.truncated).toBe(false);
		expect(plan.covered).toBe(401);
	});

	it('a projection that plateaus at ZERO can never cover the audience: sentinel, not a partial plan', () => {
		// The regression this pins: [100, 0] with 300 recipients used to return
		// { days: 1, slices: [100] } — a "plan" that silently dropped 200 people.
		const plan = planCampaignCapacity({
			audienceSize: 300,
			remainingCapacityByDay: [100, 0],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan).toEqual({
			fits: false,
			days: 0,
			slices: [],
			finishesAt: MIDNIGHT,
			covered: 0,
			truncated: false,
			audienceUnderCounted: false,
		});
	});

	it('a plateau at zero AFTER the audience is covered still yields a real schedule', () => {
		// Same trailing zero, but the projected days do cover everyone — this must
		// stay a genuine multi-day plan and must NOT collapse to the sentinel.
		const plan = planCampaignCapacity({
			audienceSize: 150,
			remainingCapacityByDay: [100, 100, 0],
			maxMessageAgeMs: MS_PER_DAY,
			now: MIDNIGHT,
		});
		expect(plan).toEqual({
			fits: false,
			days: 2,
			slices: [100, 50],
			finishesAt: MIDNIGHT + 2 * MS_PER_DAY,
			covered: 150,
			truncated: false,
			audienceUnderCounted: false,
		});
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
		expect(plan).toEqual({
			fits: false,
			days: 0,
			slices: [],
			finishesAt: MIDNIGHT,
			covered: 0,
			truncated: false,
			audienceUnderCounted: false,
		});
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

describe('planCampaignCapacity — the MAX_PLAN_DAYS boundary', () => {
	/**
	 * The twin of the truncation row. An audience covered EXACTLY on the last
	 * enumerable day is a COMPLETE schedule; one recipient more is truncated.
	 * These two rows together pin the off-by-one between "60 days is enough"
	 * and "60 days is not enough".
	 */
	it('an audience covered exactly on day MAX_PLAN_DAYS is complete, not truncated', () => {
		const plan = planCampaignCapacity({
			audienceSize: 10 * MAX_PLAN_DAYS,
			remainingCapacityByDay: [10],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan.fits).toBe(false);
		if (plan.fits) return;
		expect(plan.days).toBe(MAX_PLAN_DAYS);
		expect(plan.truncated).toBe(false);
		expect(plan.covered).toBe(10 * MAX_PLAN_DAYS);
		expect(plan.finishesAt).toBe(MIDNIGHT + MAX_PLAN_DAYS * MS_PER_DAY);
	});

	it('one recipient past the last enumerable day flips it to truncated', () => {
		const plan = planCampaignCapacity({
			audienceSize: 10 * MAX_PLAN_DAYS + 1,
			remainingCapacityByDay: [10],
			maxMessageAgeMs: FOUR_DAYS,
			now: MIDNIGHT,
		});
		expect(plan.fits).toBe(false);
		if (plan.fits) return;
		expect(plan.days).toBe(MAX_PLAN_DAYS);
		expect(plan.truncated).toBe(true);
		expect(plan.covered).toBe(10 * MAX_PLAN_DAYS);
	});
});

describe('buildCapacitySchedule — the horizon-free enumeration', () => {
	it('enumerates a schedule the horizon-gated planner would have short-circuited', () => {
		// planCampaignCapacity answers `{ fits: true }` here (200 lands inside the
		// four-day horizon); the advisory readout still wants the day slices.
		expect(
			planCampaignCapacity({
				audienceSize: 200,
				remainingCapacityByDay: [100, 100, 100],
				maxMessageAgeMs: FOUR_DAYS,
				now: MIDNIGHT,
			})
		).toEqual({ fits: true });

		expect(
			buildCapacitySchedule({
				audienceSize: 200,
				remainingCapacityByDay: [100, 100, 100],
				now: MIDNIGHT,
			})
		).toEqual({
			fits: false,
			days: 2,
			slices: [100, 100],
			finishesAt: MIDNIGHT + 2 * MS_PER_DAY,
			covered: 200,
			truncated: false,
			audienceUnderCounted: false,
		});
	});

	it('returns the days === 0 sentinel when no schedule can reach everyone', () => {
		const schedule = buildCapacitySchedule({
			audienceSize: 300,
			remainingCapacityByDay: [100, 0],
			now: MIDNIGHT,
		});
		expect(schedule.days).toBe(0);
		expect(schedule.slices).toEqual([]);
		expect(schedule.covered).toBe(0);
	});

	it('is inert on an empty audience', () => {
		const schedule = buildCapacitySchedule({
			audienceSize: 0,
			remainingCapacityByDay: [100],
			now: MIDNIGHT,
		});
		expect(schedule.days).toBe(0);
		expect(schedule.covered).toBe(0);
	});
});
