/**
 * THE OPERATOR-FACING PROGRESS STATE — "Sending over 4 days · day 1 of 4 · 5 000
 * of 20 000", present FROM THE MOMENT THE SEND STARTS (plan D14, P3-7).
 *
 * Its own module rather than a third concern inside `multiDaySendPlan.ts`: the
 * planner decides how much goes out today, and this shapes a sentence for a
 * different layer entirely (`sendPlanQueries` -> the Vue component). The two are
 * edited for different reasons and by different changes.
 *
 * A multi-day send is a normal, visible state for a warming deployment. It is
 * NEVER an error state and never a warning: this module has no failure shape at
 * all, and a plan it cannot describe degrades to the single-day sentence rather
 * than to a nag.
 *
 * PURE (plan D15): every input is a parameter.
 */

import { MAX_PLAN_DAYS } from './capacityPlan';
import type { SendPlanState } from './multiDaySendPlan';

export interface CampaignSendPlanProgress {
	/** Render the day-of-N line at all? False for an ordinary same-day send. */
	readonly isMultiDay: boolean;
	/** 1-based day being sent right now. Always at least 1. */
	readonly day: number;
	/** Days the plan spans. Always at least 1. */
	readonly totalDays: number;
	readonly enqueued: number;
	readonly total: number;
	/**
	 * `total` is a LOWER BOUND — the audience count stopped at a ceiling or ran
	 * out of read budget. The copy says "of at least N", never "of N" (plan D14).
	 */
	readonly isTotalLowerBound: boolean;
	/** The plan is longer than `MAX_PLAN_DAYS`: the copy says "more than N days". */
	readonly isTruncated: boolean;
}

/** Non-negative finite integer, or 0 for anything hostile. */
function sanitizeCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

export function campaignSendPlanProgress(input: {
	readonly plan: SendPlanState;
	readonly enqueuedCount: number | undefined;
}): CampaignSendPlanProgress {
	const { plan } = input;
	const totalDays = Math.max(1, sanitizeCount(plan.planTotalDays));
	const day = Math.min(totalDays, Math.max(1, sanitizeCount(plan.planDayIndex) + 1));
	const total = sanitizeCount(plan.plannedTotal);
	return {
		isMultiDay: totalDays > 1,
		day,
		totalDays,
		enqueued: sanitizeCount(input.enqueuedCount),
		total,
		// Only a denominator we actually have can be qualified: with no total at
		// all the copy quotes no denominator, so there is nothing to hedge.
		isTotalLowerBound: total > 0 && plan.isPlannedTotalLowerBound === true,
		isTruncated: sanitizeCount(plan.planTotalDays) >= MAX_PLAN_DAYS,
	};
}
