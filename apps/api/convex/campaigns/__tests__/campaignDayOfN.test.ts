/**
 * "SENDING OVER 4 DAYS · DAY 1 OF 4 · 5 000 OF 20 000" (plan D14, P3-7).
 *
 * A multi-day send is a NORMAL, VISIBLE state for a warming deployment — not an
 * error and not a surprise — and the line has to be there from the moment the
 * send starts rather than appearing once a plan turns out to be long.
 *
 * The property this suite really enforces is that the derivation has NO FAILURE
 * SHAPE AT ALL: every input, including the hostile ones, produces a renderable
 * day-of-N. There is nothing here for a UI to show as a warning, a nag or an
 * unresolvable "setup incomplete" (plan D2).
 */

import { describe, expect, it } from 'vitest';
import { campaignSendPlanProgress } from '../sendPlanProgress';
import { MAX_PLAN_DAYS } from '../capacityPlan';
import { planTodaysSlice, type SendPlanState } from '../multiDaySendPlan';

/** The plan clump, so each case states only the fields it is about. */
function plan(overrides: Partial<SendPlanState> = {}): SendPlanState {
	return {
		planDayKey: undefined,
		enqueuedToday: undefined,
		planDayIndex: undefined,
		planTotalDays: undefined,
		isPlanTruncated: undefined,
		plannedTotal: undefined,
		isPlannedTotalLowerBound: undefined,
		...overrides,
	};
}

describe('campaignSendPlanProgress', () => {
	it('reports day 1 of N from the very first hop', () => {
		const progress = campaignSendPlanProgress({
			plan: plan({ planDayIndex: 0, planTotalDays: 4, plannedTotal: 20_000 }),
			enqueuedCount: 0,
		});
		expect(progress).toEqual({
			isMultiDay: true,
			day: 1,
			totalDays: 4,
			enqueued: 0,
			total: 20_000,
			isTotalLowerBound: false,
			isTruncated: false,
		});
	});

	it('advances the day without ever exceeding the plan length', () => {
		expect(
			campaignSendPlanProgress({
				plan: plan({ planDayIndex: 3, planTotalDays: 4, plannedTotal: 20_000 }),
				enqueuedCount: 15_000,
			}).day
		).toBe(4);
		// A stored index past the end of a plan that was re-shortened mid-flight
		// still renders a sentence, and never "day 9 of 4".
		expect(
			campaignSendPlanProgress({
				plan: plan({ planDayIndex: 8, planTotalDays: 4, plannedTotal: 20_000 }),
				enqueuedCount: 20_000,
			}).day
		).toBe(4);
	});

	it('an ordinary same-day send is simply not multi-day', () => {
		const progress = campaignSendPlanProgress({
			plan: plan({ planDayIndex: 0, planTotalDays: 1, plannedTotal: 500 }),
			enqueuedCount: 500,
		});
		expect(progress.isMultiDay).toBe(false);
		expect(progress.day).toBe(1);
		expect(progress.totalDays).toBe(1);
	});

	it('a walk with NO plan state at all still renders — day 1 of 1', () => {
		const progress = campaignSendPlanProgress({
			plan: plan({ planDayIndex: undefined, planTotalDays: undefined, plannedTotal: undefined }),
			enqueuedCount: undefined,
		});
		expect(progress.isMultiDay).toBe(false);
		expect(progress.day).toBe(1);
		expect(progress.totalDays).toBe(1);
		expect(progress.enqueued).toBe(0);
		expect(progress.total).toBe(0);
	});

	it('says the quiet part when the plan is longer than we will enumerate', () => {
		const progress = campaignSendPlanProgress({
			plan: plan({
				planDayIndex: 2,
				planTotalDays: MAX_PLAN_DAYS,
				isPlanTruncated: true,
				plannedTotal: 900_000,
			}),
			enqueuedCount: 30_000,
		});
		expect(progress.isTruncated).toBe(true);
		expect(progress.isMultiDay).toBe(true);
	});

	/**
	 * THE SAME LENGTH, THE OPPOSITE FACT — end to end from the planner that
	 * produced the checkpoint. Truncation used to be re-derived here as
	 * `planTotalDays >= MAX_PLAN_DAYS`, which told an operator whose send is
	 * fully scheduled — the last recipient goes out on day MAX_PLAN_DAYS — that
	 * it runs "more than 60 days". A schedule that covers its audience is
	 * complete however long it is (plan D14).
	 */
	describe('a plan exactly MAX_PLAN_DAYS long', () => {
		/** Checkpoint the walker would write for `remaining` at 100/day. */
		function checkpointFor(remaining: number): SendPlanState {
			const slice = planTodaysSlice({
				state: plan(),
				remaining: { kind: 'exact', count: remaining },
				capacityByDay: [100],
				now: Date.UTC(2026, 0, 1, 12),
			});
			return plan({
				planDayKey: slice.dayKey,
				planDayIndex: slice.dayIndex,
				planTotalDays: slice.totalDays,
				isPlanTruncated: slice.isTruncated,
				plannedTotal: remaining,
			});
		}

		it('is COMPLETE when the audience is covered on the last day', () => {
			const covered = checkpointFor(100 * MAX_PLAN_DAYS);
			expect(covered.planTotalDays).toBe(MAX_PLAN_DAYS);
			const progress = campaignSendPlanProgress({ plan: covered, enqueuedCount: 0 });
			expect(progress.totalDays).toBe(MAX_PLAN_DAYS);
			expect(progress.isTruncated).toBe(false);
		});

		it('is TRUNCATED when one recipient is left over', () => {
			const overflowing = checkpointFor(100 * MAX_PLAN_DAYS + 1);
			expect(overflowing.planTotalDays).toBe(MAX_PLAN_DAYS);
			const progress = campaignSendPlanProgress({ plan: overflowing, enqueuedCount: 0 });
			expect(progress.isTruncated).toBe(true);
		});

		it('reads a PRE-MIGRATION row as complete until its next hop rewrites it', () => {
			// The flag is absent on every row written before it existed, including
			// rows that really are truncated. Absence reads as NOT truncated: the
			// copy quotes the length it has and makes no hedge, rather than making a
			// false one. The next hop recomputes the length and writes the flag with
			// it, so the stale reading is bounded by one cap window.
			const remaining = 100 * MAX_PLAN_DAYS + 1;
			const preMigration = plan({
				planDayIndex: 2,
				planTotalDays: MAX_PLAN_DAYS,
				plannedTotal: remaining,
			});
			expect(preMigration.isPlanTruncated).toBeUndefined();
			expect(campaignSendPlanProgress({ plan: preMigration, enqueuedCount: 0 }).isTruncated).toBe(
				false
			);

			const nextHop = planTodaysSlice({
				state: preMigration,
				remaining: { kind: 'exact', count: remaining },
				capacityByDay: [100],
				now: Date.UTC(2026, 0, 1, 12),
			});
			expect(
				campaignSendPlanProgress({
					plan: plan({ ...preMigration, isPlanTruncated: nextHop.isTruncated }),
					enqueuedCount: 0,
				}).isTruncated
			).toBe(true);
		});
	});

	it('says the quiet part about the denominator too (plan D14)', () => {
		const bounded = campaignSendPlanProgress({
			plan: plan({
				planDayIndex: 0,
				planTotalDays: 4,
				plannedTotal: 1_500,
				isPlannedTotalLowerBound: true,
			}),
			enqueuedCount: 500,
		});
		// A count that stopped early is a FLOOR, and the copy renders it as one.
		expect(bounded.isTotalLowerBound).toBe(true);
		expect(bounded.total).toBe(1_500);
	});

	it('has nothing to hedge when there is no denominator at all', () => {
		const none = campaignSendPlanProgress({
			plan: plan({ planTotalDays: 4, isPlannedTotalLowerBound: true }),
			enqueuedCount: 500,
		});
		expect(none.total).toBe(0);
		expect(none.isTotalLowerBound).toBe(false);
	});

	it('is never an error state, whatever the row holds', () => {
		const hostile = [
			{ planDayIndex: Number.NaN, planTotalDays: Number.NaN },
			{ planDayIndex: -5, planTotalDays: -5 },
			{ planDayIndex: Infinity, planTotalDays: 0 },
		];
		for (const state of hostile) {
			const progress = campaignSendPlanProgress({
				plan: plan({ ...state, plannedTotal: -1 }),
				enqueuedCount: Number.NaN,
			});
			expect(progress.day).toBeGreaterThanOrEqual(1);
			expect(progress.totalDays).toBeGreaterThanOrEqual(1);
			expect(progress.day).toBeLessThanOrEqual(progress.totalDays);
			expect(Number.isFinite(progress.enqueued)).toBe(true);
			expect(Number.isFinite(progress.total)).toBe(true);
		}
	});
});
