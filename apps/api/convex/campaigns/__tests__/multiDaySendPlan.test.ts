/**
 * THE MULTI-DAY SEND PLAN (deliverability plan P3-7, D2, D14).
 *
 * A warming deployment with no relay to overflow to sends a large campaign over
 * several days: the walker takes only today's capacity slice, in engagement
 * order, and resumes in the next cap window. This suite pins the four things
 * that have to be true of that — today's slice, the resume target, the resume
 * ACROSS days, and a capacity change mid-plan — plus the rule that governs all
 * of them: unmeasured capacity never withholds mail.
 */

import { describe, expect, it } from 'vitest';
import { orderByEngagement, planTodaysSlice, type SendPlanState } from '../multiDaySendPlan';
import { utcDayKey } from '../../lib/utcDay';

const DAY = 24 * 60 * 60 * 1000;
const DAY_START = Math.floor(1_800_000_000_000 / DAY) * DAY;
const NOON = DAY_START + DAY / 2;
const TODAY = utcDayKey(NOON);
const TOMORROW = utcDayKey(NOON + DAY);

const NO_PLAN: SendPlanState = {
	planDayKey: undefined,
	enqueuedToday: undefined,
	planDayIndex: undefined,
	planTotalDays: undefined,
};

describe("planTodaysSlice — today's slice", () => {
	it('budgets exactly today’s projected capacity', () => {
		const slice = planTodaysSlice({
			state: NO_PLAN,
			remaining: 20_000,
			capacityByDay: [5_000, 5_000, 5_000, 5_000],
			now: NOON,
		});
		expect(slice.capacityToday).toBe(5_000);
		expect(slice.remainingToday).toBe(5_000);
		expect(slice.isDayExhausted).toBe(false);
		expect(slice.dayKey).toBe(TODAY);
		expect(slice.dayIndex).toBe(0);
		expect(slice.totalDays).toBe(4);
	});

	it('counts what today has already carried', () => {
		const slice = planTodaysSlice({
			state: { ...NO_PLAN, planDayKey: TODAY, enqueuedToday: 4_500, planDayIndex: 0 },
			remaining: 15_500,
			capacityByDay: [5_000, 5_000, 5_000, 5_000],
			now: NOON,
		});
		expect(slice.remainingToday).toBe(500);
		expect(slice.isDayExhausted).toBe(false);
	});

	it('exhausts the day and resumes at the NEXT CAP WINDOW, not a blind retry', () => {
		const slice = planTodaysSlice({
			state: { ...NO_PLAN, planDayKey: TODAY, enqueuedToday: 5_000, planDayIndex: 0 },
			remaining: 15_000,
			capacityByDay: [5_000, 5_000, 5_000, 5_000],
			now: NOON,
		});
		expect(slice.isDayExhausted).toBe(true);
		expect(slice.resumeAt).toBe(DAY_START + DAY);
		expect(slice.remainingToday).toBe(0);
	});

	it('a projected ZERO for today is a real reading and exhausts the day', () => {
		const slice = planTodaysSlice({
			state: NO_PLAN,
			remaining: 1_000,
			capacityByDay: [0, 5_000],
			now: NOON,
		});
		expect(slice.isDayExhausted).toBe(true);
		expect(slice.resumeAt).toBe(DAY_START + DAY);
	});

	it('does not exhaust a day once the audience is covered', () => {
		const slice = planTodaysSlice({
			state: { ...NO_PLAN, planDayKey: TODAY, enqueuedToday: 5_000 },
			remaining: 0,
			capacityByDay: [5_000, 5_000],
			now: NOON,
		});
		expect(slice.isDayExhausted).toBe(false);
		expect(slice.resumeAt).toBeUndefined();
	});
});

describe('planTodaysSlice — resuming across days', () => {
	it('rolls the day over: the counter restarts and the plan advances a day', () => {
		const slice = planTodaysSlice({
			state: { planDayKey: TODAY, enqueuedToday: 5_000, planDayIndex: 0, planTotalDays: 4 },
			remaining: 15_000,
			capacityByDay: [5_000, 5_000, 5_000],
			now: NOON + DAY,
		});
		expect(slice.dayKey).toBe(TOMORROW);
		expect(slice.enqueuedToday).toBe(0);
		expect(slice.dayIndex).toBe(1);
		expect(slice.remainingToday).toBe(5_000);
		expect(slice.isDayExhausted).toBe(false);
	});

	it('a walk re-driven days later resumes as the NEXT day of the plan', () => {
		const slice = planTodaysSlice({
			state: { planDayKey: TODAY, enqueuedToday: 5_000, planDayIndex: 1, planTotalDays: 4 },
			remaining: 10_000,
			capacityByDay: [5_000, 5_000],
			now: NOON + 3 * DAY,
		});
		expect(slice.dayIndex).toBe(2);
		expect(slice.enqueuedToday).toBe(0);
	});
});

describe('planTodaysSlice — a capacity change mid-plan', () => {
	it('re-lengthens the plan when capacity shrinks', () => {
		const before = planTodaysSlice({
			state: NO_PLAN,
			remaining: 20_000,
			capacityByDay: [10_000, 10_000],
			now: NOON,
		});
		expect(before.totalDays).toBe(2);

		const after = planTodaysSlice({
			state: { planDayKey: TODAY, enqueuedToday: 2_000, planDayIndex: 0, planTotalDays: 2 },
			remaining: 18_000,
			// The pace actuator retreated, or an IP left the pool.
			capacityByDay: [2_000, 2_000, 2_000],
			now: NOON,
		});
		expect(after.totalDays).toBeGreaterThan(2);
		// Today's budget is already spent under the new, smaller cap.
		expect(after.remainingToday).toBe(0);
		expect(after.isDayExhausted).toBe(true);
	});

	it('re-shortens the plan when capacity grows', () => {
		const after = planTodaysSlice({
			state: { planDayKey: TODAY, enqueuedToday: 1_000, planDayIndex: 0, planTotalDays: 6 },
			remaining: 9_000,
			capacityByDay: [10_000, 10_000],
			now: NOON,
		});
		expect(after.totalDays).toBe(1);
		expect(after.remainingToday).toBe(9_000);
	});
});

describe('planTodaysSlice — unmeasured capacity never withholds mail (D2)', () => {
	it('imposes NO budget when there is no projection at all', () => {
		const slice = planTodaysSlice({
			state: NO_PLAN,
			remaining: 20_000,
			capacityByDay: [],
			now: NOON,
		});
		expect(slice.remainingToday).toBeUndefined();
		expect(slice.capacityToday).toBeUndefined();
		expect(slice.isDayExhausted).toBe(false);
		expect(slice.resumeAt).toBeUndefined();
	});

	it('imposes no budget when the plan cannot be built at all', () => {
		// A projection that plateaus at zero before the audience is covered is the
		// planner's "cannot be planned" sentinel — unknown, and unknown allows.
		const slice = planTodaysSlice({
			state: NO_PLAN,
			remaining: 20_000,
			capacityByDay: [0, 0],
			now: NOON,
		});
		expect(slice.remainingToday).toBeUndefined();
		expect(slice.isDayExhausted).toBe(false);
	});

	it('an UNKNOWN remaining count still respects the day budget', () => {
		// The walker only asks while it still has pages, so "unknown" means "at
		// least one" — never zero, which would waive the budget entirely.
		const slice = planTodaysSlice({
			state: { planDayKey: TODAY, enqueuedToday: 5_000, planDayIndex: 0, planTotalDays: 4 },
			remaining: undefined,
			capacityByDay: [5_000, 5_000],
			now: NOON,
		});
		expect(slice.isDayExhausted).toBe(true);
		expect(slice.totalDays).toBe(4);
	});

	it('survives a hostile clock and hostile counters', () => {
		const slice = planTodaysSlice({
			state: { planDayKey: TODAY, enqueuedToday: Number.NaN, planDayIndex: -3, planTotalDays: 0 },
			remaining: Number.NaN,
			capacityByDay: [Number.NaN, 5_000],
			now: Number.NaN,
		});
		expect(Number.isFinite(slice.dayIndex)).toBe(true);
		expect(slice.dayIndex).toBeGreaterThanOrEqual(0);
		expect(slice.enqueuedToday).toBe(0);
	});
});

describe('orderByEngagement — the best remaining audience goes first', () => {
	it('sorts by engagement score, descending', () => {
		const ordered = orderByEngagement([
			{ id: 'low', engagementScore: 10 },
			{ id: 'high', engagementScore: 90 },
			{ id: 'mid', engagementScore: 50 },
		]);
		expect(ordered.map((r) => r.id)).toEqual(['high', 'mid', 'low']);
	});

	it('puts UNSCORED recipients last — absence is not evidence of engagement', () => {
		const ordered = orderByEngagement([{ id: 'unscored' }, { id: 'scored', engagementScore: 1 }]);
		expect(ordered.map((r) => r.id)).toEqual(['scored', 'unscored']);
	});

	it('is stable for equal scores and does not mutate its input', () => {
		const input = [
			{ id: 'a', engagementScore: 5 },
			{ id: 'b', engagementScore: 5 },
			{ id: 'c', engagementScore: 5 },
		];
		expect(orderByEngagement(input).map((r) => r.id)).toEqual(['a', 'b', 'c']);
		expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c']);
	});

	it('treats a non-finite score as unscored rather than sorting on NaN', () => {
		const ordered = orderByEngagement([
			{ id: 'nan', engagementScore: Number.NaN },
			{ id: 'zero', engagementScore: 0 },
		]);
		expect(ordered.map((r) => r.id)).toEqual(['zero', 'nan']);
	});
});
