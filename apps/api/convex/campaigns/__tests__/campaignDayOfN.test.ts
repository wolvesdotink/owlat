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
import { campaignSendPlanProgress } from '../multiDaySendPlan';
import { MAX_PLAN_DAYS } from '../capacityPlan';

describe('campaignSendPlanProgress', () => {
	it('reports day 1 of N from the very first hop', () => {
		const progress = campaignSendPlanProgress({
			planDayIndex: 0,
			planTotalDays: 4,
			enqueuedCount: 0,
			plannedTotal: 20_000,
		});
		expect(progress).toEqual({
			isMultiDay: true,
			day: 1,
			totalDays: 4,
			enqueued: 0,
			total: 20_000,
			isTruncated: false,
		});
	});

	it('advances the day without ever exceeding the plan length', () => {
		expect(
			campaignSendPlanProgress({
				planDayIndex: 3,
				planTotalDays: 4,
				enqueuedCount: 15_000,
				plannedTotal: 20_000,
			}).day
		).toBe(4);
		// A stored index past the end of a plan that was re-shortened mid-flight
		// still renders a sentence, and never "day 9 of 4".
		expect(
			campaignSendPlanProgress({
				planDayIndex: 8,
				planTotalDays: 4,
				enqueuedCount: 20_000,
				plannedTotal: 20_000,
			}).day
		).toBe(4);
	});

	it('an ordinary same-day send is simply not multi-day', () => {
		const progress = campaignSendPlanProgress({
			planDayIndex: 0,
			planTotalDays: 1,
			enqueuedCount: 500,
			plannedTotal: 500,
		});
		expect(progress.isMultiDay).toBe(false);
		expect(progress.day).toBe(1);
		expect(progress.totalDays).toBe(1);
	});

	it('a walk with NO plan state at all still renders — day 1 of 1', () => {
		const progress = campaignSendPlanProgress({
			planDayIndex: undefined,
			planTotalDays: undefined,
			enqueuedCount: undefined,
			plannedTotal: undefined,
		});
		expect(progress.isMultiDay).toBe(false);
		expect(progress.day).toBe(1);
		expect(progress.totalDays).toBe(1);
		expect(progress.enqueued).toBe(0);
		expect(progress.total).toBe(0);
	});

	it('says the quiet part when the plan is longer than we will enumerate', () => {
		const progress = campaignSendPlanProgress({
			planDayIndex: 2,
			planTotalDays: MAX_PLAN_DAYS,
			enqueuedCount: 30_000,
			plannedTotal: 900_000,
		});
		expect(progress.isTruncated).toBe(true);
		expect(progress.isMultiDay).toBe(true);
	});

	it('is never an error state, whatever the row holds', () => {
		const hostile = [
			{ planDayIndex: Number.NaN, planTotalDays: Number.NaN },
			{ planDayIndex: -5, planTotalDays: -5 },
			{ planDayIndex: Infinity, planTotalDays: 0 },
		];
		for (const state of hostile) {
			const progress = campaignSendPlanProgress({
				...state,
				enqueuedCount: Number.NaN,
				plannedTotal: -1,
			});
			expect(progress.day).toBeGreaterThanOrEqual(1);
			expect(progress.totalDays).toBeGreaterThanOrEqual(1);
			expect(progress.day).toBeLessThanOrEqual(progress.totalDays);
			expect(Number.isFinite(progress.enqueued)).toBe(true);
			expect(Number.isFinite(progress.total)).toBe(true);
		}
	});
});
