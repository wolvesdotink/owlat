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
import {
	orderByEngagement,
	planTodaysSlice,
	remainingRecipients,
	type RemainingRecipients,
	type SendPlanState,
} from '../multiDaySendPlan';
import { MAX_PLAN_DAYS } from '../capacityPlan';
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
	isPlanTruncated: undefined,
	plannedTotal: undefined,
	isPlannedTotalLowerBound: undefined,
};

/** An audience counted to the end: the number IS the size. */
const exact = (count: number): RemainingRecipients => ({ kind: 'exact', count });
/** A count that stopped early: the number is a FLOOR under the size. */
const atLeast = (count: number): RemainingRecipients => ({ kind: 'atLeast', count });
const UNKNOWN: RemainingRecipients = { kind: 'unknown' };

describe("planTodaysSlice — today's slice", () => {
	it('budgets exactly today’s projected capacity', () => {
		const slice = planTodaysSlice({
			state: NO_PLAN,
			remaining: exact(20_000),
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
			remaining: exact(15_500),
			capacityByDay: [5_000, 5_000, 5_000, 5_000],
			now: NOON,
		});
		expect(slice.remainingToday).toBe(500);
		expect(slice.isDayExhausted).toBe(false);
	});

	it('exhausts the day and resumes at the NEXT CAP WINDOW, not a blind retry', () => {
		const slice = planTodaysSlice({
			state: { ...NO_PLAN, planDayKey: TODAY, enqueuedToday: 5_000, planDayIndex: 0 },
			remaining: exact(15_000),
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
			remaining: exact(1_000),
			capacityByDay: [0, 5_000],
			now: NOON,
		});
		expect(slice.isDayExhausted).toBe(true);
		expect(slice.resumeAt).toBe(DAY_START + DAY);
	});

	it('does not exhaust a day once the audience is covered', () => {
		const slice = planTodaysSlice({
			state: { ...NO_PLAN, planDayKey: TODAY, enqueuedToday: 5_000 },
			remaining: exact(0),
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
			state: {
				...NO_PLAN,
				planDayKey: TODAY,
				enqueuedToday: 5_000,
				planDayIndex: 0,
				planTotalDays: 4,
			},
			remaining: exact(15_000),
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
			state: {
				...NO_PLAN,
				planDayKey: TODAY,
				enqueuedToday: 5_000,
				planDayIndex: 1,
				planTotalDays: 4,
			},
			remaining: exact(10_000),
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
			remaining: exact(20_000),
			capacityByDay: [10_000, 10_000],
			now: NOON,
		});
		expect(before.totalDays).toBe(2);

		const after = planTodaysSlice({
			state: {
				...NO_PLAN,
				planDayKey: TODAY,
				enqueuedToday: 2_000,
				planDayIndex: 0,
				planTotalDays: 2,
			},
			remaining: exact(18_000),
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
			state: {
				...NO_PLAN,
				planDayKey: TODAY,
				enqueuedToday: 1_000,
				planDayIndex: 0,
				planTotalDays: 6,
			},
			remaining: exact(9_000),
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
			remaining: exact(20_000),
			capacityByDay: [],
			now: NOON,
		});
		expect(slice.remainingToday).toBeUndefined();
		expect(slice.capacityToday).toBeUndefined();
		expect(slice.isDayExhausted).toBe(false);
		expect(slice.resumeAt).toBeUndefined();
	});

	it('an UNPLANNABLE LENGTH still imposes today’s budget', () => {
		// A projection that plateaus at zero before the audience is covered yields
		// the planner's "cannot be planned" sentinel. That is an unknown LENGTH —
		// it is NOT permission to empty a 20 000-recipient audience into a queue
		// that expires it, which is what conflating the two used to do.
		const slice = planTodaysSlice({
			state: NO_PLAN,
			remaining: exact(20_000),
			capacityByDay: [0, 0],
			now: NOON,
		});
		expect(slice.capacityToday).toBe(0);
		expect(slice.remainingToday).toBe(0);
		expect(slice.isDayExhausted).toBe(true);
		expect(slice.totalDays).toBe(0);
	});

	it('an UNKNOWN remaining count still respects the day budget', () => {
		// The walker only asks while it still has pages, so "unknown" means "at
		// least one" — never zero, which would waive the budget entirely.
		const slice = planTodaysSlice({
			state: {
				...NO_PLAN,
				planDayKey: TODAY,
				enqueuedToday: 5_000,
				planDayIndex: 0,
				planTotalDays: 4,
			},
			remaining: UNKNOWN,
			capacityByDay: [5_000, 5_000],
			now: NOON,
		});
		expect(slice.isDayExhausted).toBe(true);
		expect(slice.totalDays).toBe(4);
	});

	it('survives a hostile clock and hostile counters', () => {
		const slice = planTodaysSlice({
			state: {
				...NO_PLAN,
				planDayKey: TODAY,
				enqueuedToday: Number.NaN,
				planDayIndex: -3,
				planTotalDays: 0,
			},
			remaining: exact(Number.NaN),
			capacityByDay: [Number.NaN, 5_000],
			now: Number.NaN,
		});
		expect(Number.isFinite(slice.dayIndex)).toBe(true);
		expect(slice.dayIndex).toBeGreaterThanOrEqual(0);
		expect(slice.enqueuedToday).toBe(0);
	});
});

describe('planTodaysSlice — a LOWER-BOUND denominator (the truncated count)', () => {
	/**
	 * The failure this pins: `countAudience` reads a bounded number of documents,
	 * so a large topic audience comes back truncated. Treating that floor as the
	 * audience size made the plan look finished, waived the day budget, and let
	 * the walker empty the whole audience into a queue that expires the tail —
	 * on exactly the campaigns the multi-day plan exists for.
	 */
	it('keeps today’s budget when the count is only a floor', () => {
		const slice = planTodaysSlice({
			state: NO_PLAN,
			// 1 500 counted of a real 20 000: the read budget ran out.
			remaining: atLeast(1_500),
			capacityByDay: [5_000, 5_000, 5_000, 5_000],
			now: NOON,
		});
		expect(slice.remainingToday).toBe(5_000);
		expect(slice.capacityToday).toBe(5_000);
	});

	it('a floor of ZERO never means "the audience is finished"', () => {
		const slice = planTodaysSlice({
			state: { ...NO_PLAN, planDayKey: TODAY, enqueuedToday: 5_000 },
			remaining: atLeast(0),
			capacityByDay: [5_000, 5_000],
			now: NOON,
		});
		expect(slice.remainingToday).toBe(0);
		expect(slice.isDayExhausted).toBe(true);
	});

	it('LENGTHENS the plan rather than shortening it', () => {
		const slice = planTodaysSlice({
			// The walk already believes the plan is four days long.
			state: { ...NO_PLAN, planDayKey: TODAY, planDayIndex: 0, planTotalDays: 4 },
			// A floor that would compute one day on its own.
			remaining: atLeast(1_500),
			capacityByDay: [5_000, 5_000, 5_000, 5_000],
			now: NOON,
		});
		expect(slice.totalDays).toBe(4);
	});

	it('never withdraws a truncation an earlier floor established', () => {
		const slice = planTodaysSlice({
			// A previous hop planned past MAX_PLAN_DAYS from a floor.
			state: {
				...NO_PLAN,
				planDayKey: TODAY,
				planDayIndex: 0,
				planTotalDays: MAX_PLAN_DAYS,
				isPlanTruncated: true,
			},
			// A later floor that fits comfortably — of an audience that can only be
			// bigger than the one already found not to fit.
			remaining: atLeast(1_500),
			capacityByDay: [5_000, 5_000],
			now: NOON,
		});
		expect(slice.totalDays).toBe(MAX_PLAN_DAYS);
		expect(slice.isTruncated).toBe(true);
	});
});

describe('planTodaysSlice — "more than N days" is a fact, not a length', () => {
	/**
	 * The failure this pins: truncation used to be re-derived downstream as
	 * `planTotalDays >= MAX_PLAN_DAYS`, so a plan that covered its audience on
	 * the very last enumerable day — a COMPLETE schedule — told the operator
	 * their send runs "more than 60 days". The schedule knows which it is; the
	 * length never can.
	 */
	it('a plan that covers the audience ON day MAX_PLAN_DAYS is complete', () => {
		const slice = planTodaysSlice({
			state: NO_PLAN,
			// 100/day for exactly MAX_PLAN_DAYS days, and not one recipient more.
			remaining: exact(100 * MAX_PLAN_DAYS),
			capacityByDay: [100],
			now: NOON,
		});
		expect(slice.totalDays).toBe(MAX_PLAN_DAYS);
		expect(slice.isTruncated).toBe(false);
	});

	it('one recipient more and it is truncated at the same length', () => {
		const slice = planTodaysSlice({
			state: NO_PLAN,
			remaining: exact(100 * MAX_PLAN_DAYS + 1),
			capacityByDay: [100],
			now: NOON,
		});
		expect(slice.totalDays).toBe(MAX_PLAN_DAYS);
		expect(slice.isTruncated).toBe(true);
	});

	it('carries the checkpoint’s reading when the length cannot be recomputed', () => {
		const slice = planTodaysSlice({
			state: {
				...NO_PLAN,
				planDayKey: TODAY,
				planDayIndex: 0,
				planTotalDays: MAX_PLAN_DAYS,
				isPlanTruncated: true,
			},
			// No denominator on this hop: the length is carried, so its truncation
			// must be carried with it rather than re-derived from the number.
			remaining: UNKNOWN,
			capacityByDay: [5_000, 5_000],
			now: NOON,
		});
		expect(slice.totalDays).toBe(MAX_PLAN_DAYS);
		expect(slice.isTruncated).toBe(true);
	});

	it('an EXACT recount that now fits withdraws the truncation', () => {
		const slice = planTodaysSlice({
			state: {
				...NO_PLAN,
				planDayKey: TODAY,
				planDayIndex: 0,
				planTotalDays: MAX_PLAN_DAYS,
				isPlanTruncated: true,
			},
			// Capacity grew (an IP was added): the plan re-shortens, and the copy
			// stops promising mail that is already scheduled to go out.
			remaining: exact(1_000),
			capacityByDay: [5_000, 5_000],
			now: NOON,
		});
		expect(slice.totalDays).toBe(1);
		expect(slice.isTruncated).toBe(false);
	});
});

describe('remainingRecipients — how well the denominator is known', () => {
	it('is UNKNOWN when the count was never taken', () => {
		expect(remainingRecipients(NO_PLAN, 100)).toEqual({ kind: 'unknown' });
	});

	it('is EXACT when the count finished, and nets off what has gone out', () => {
		expect(remainingRecipients({ ...NO_PLAN, plannedTotal: 20_000 }, 5_000)).toEqual({
			kind: 'exact',
			count: 15_000,
		});
	});

	it('is a FLOOR when the count stopped early', () => {
		expect(
			remainingRecipients({ ...NO_PLAN, plannedTotal: 1_500, isPlannedTotalLowerBound: true }, 500)
		).toEqual({ kind: 'atLeast', count: 1_000 });
	});

	it('never goes negative when more went out than the count found', () => {
		expect(
			remainingRecipients(
				{ ...NO_PLAN, plannedTotal: 1_500, isPlannedTotalLowerBound: true },
				9_000
			)
		).toEqual({ kind: 'atLeast', count: 0 });
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

	it('an OUT-OF-BAND score does not jump the day’s slice', () => {
		// `contacts.engagementScore` is 0-100. A stored 250 is an upstream scorer
		// defect the dispatch envelope and the stratified ranker both refuse
		// (`normalizeEngagementScore`), and the day-one slice is the third reader
		// of the same number: ordered on its face it would take the front of the
		// first warming day, on the same send whose envelope drops it as unknown.
		const ordered = orderByEngagement([
			{ id: 'over', engagementScore: 250 },
			{ id: 'under', engagementScore: -1 },
			{ id: 'top', engagementScore: 100 },
			{ id: 'unscored' },
		]);
		// The honest top of the band leads; both defects sit with the unscored, in
		// the audience's own order because they are tied at "no usable score".
		expect(ordered.map((r) => r.id)).toEqual(['top', 'over', 'under', 'unscored']);
	});
});
