/**
 * THE MULTI-DAY SEND PLAN — the standalone answer to capacity overflow (plan
 * P3-7, D14).
 *
 * With a relay there is somewhere for the overflow to go. Without one there is
 * not, so a campaign larger than today's warming capacity is not an error and
 * not a surprise: it is a SCHEDULE. The send walker enqueues only TODAY'S
 * CAPACITY SLICE and schedules the remainder for the next cap window, drawing
 * recipients in ENGAGEMENT ORDER so each day's slice is the best remaining
 * audience — which is also the ideal warming behaviour.
 *
 * It CONSUMES P0-5's binding plan (`capacityPlan.ts`) rather than re-deriving
 * one: `buildCapacitySchedule` already owns "what can day k carry", the
 * trailing-rate extension and the `MAX_PLAN_DAYS` truncation, and a second
 * answer to those questions is a second answer the pre-flight and the walker can
 * disagree about.
 *
 * PURE (plan D15): the clock, the capacity projection and the counters are all
 * parameters. The ctx-bound half is the walker in `campaigns/send.ts`.
 *
 * DEGENERATE INPUT NEVER BLOCKS A SEND (plan D2). No capacity projection, a
 * hostile day count, a clock that makes no sense — every one of them resolves to
 * "no day budget applies", which is the shipped single-day behaviour. A
 * measurement we could not take has never been grounds to withhold mail.
 */

import { buildCapacitySchedule, MAX_PLAN_DAYS } from './capacityPlan';
import { nextUtcDayStart, utcDayKey } from '../lib/utcDay';

/** The plan state the walker checkpoints on its `campaignSendJobs` row. */
export interface SendPlanState {
	/** The `YYYY-MM-DD` UTC day the current slice belongs to. */
	readonly planDayKey: string | undefined;
	/** Recipients already enqueued on `planDayKey`. */
	readonly enqueuedToday: number | undefined;
	/** 0-based index of the current day within the plan. */
	readonly planDayIndex: number | undefined;
	/** Days the plan spanned when it was last recomputed. */
	readonly planTotalDays: number | undefined;
}

export interface SendPlanSliceInput {
	readonly state: SendPlanState;
	/**
	 * Recipients still to enqueue, or `undefined` when the walk has no denominator
	 * (the bounded audience count could not be taken). A LOWER bound is fine.
	 *
	 * UNKNOWN NEVER WAIVES THE DAY BUDGET. The walker only asks this question
	 * while it still has pages to enqueue, so "how many are left" being unknown
	 * means "at least one" — treating it as zero would let a capped deployment
	 * empty the whole audience into a queue that expires it. It does mean the
	 * plan's LENGTH is unknown, and the day count is carried forward rather than
	 * invented.
	 */
	readonly remaining: number | undefined;
	/**
	 * Projected sendable volume per day, index 0 = the REMAINDER of today — the
	 * same array `capacityPlan` consumes, produced by `delivery/warmingCapacity`.
	 * EMPTY means "no projection", which imposes no budget at all.
	 */
	readonly capacityByDay: readonly number[];
	readonly now: number;
}

export interface SendPlanSlice {
	/** The `YYYY-MM-DD` day this slice belongs to. */
	readonly dayKey: string;
	/** 0-based day index within the plan. */
	readonly dayIndex: number;
	/** Days the plan currently projects, 1-based count. `0` = not plannable. */
	readonly totalDays: number;
	/**
	 * Recipients today's slice may still carry, or `undefined` for NO BUDGET —
	 * an absent or unusable projection, which sends exactly as the shipped walker
	 * always has.
	 */
	readonly remainingToday: number | undefined;
	/** Today's whole slice, for the operator-facing progress line. */
	readonly capacityToday: number | undefined;
	/** Today's budget is spent and the walk must resume in the next cap window. */
	readonly isDayExhausted: boolean;
	/**
	 * When to resume — the start of the next UTC day, i.e. the next cap window.
	 * `undefined` unless the day is exhausted.
	 */
	readonly resumeAt: number | undefined;
	/** The counters to checkpoint, already rolled over if the day changed. */
	readonly enqueuedToday: number;
}

/** Non-negative finite integer, or 0 for anything hostile. */
function sanitizeCount(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

/**
 * DECIDE TODAY'S SLICE.
 *
 * Recomputed on EVERY hop rather than frozen at plan time, which is what makes
 * a capacity change mid-plan a non-event: the warming schedule advancing, an IP
 * being added, or the pace actuator retreating all show up as a different
 * `capacityByDay` on the next hop, and the plan simply re-lengthens or
 * re-shortens around what has already gone out. A frozen plan would keep
 * enqueueing against a cap that no longer exists.
 */
export function planTodaysSlice(input: SendPlanSliceInput): SendPlanSlice {
	const { state, capacityByDay, now } = input;
	const dayKey = utcDayKey(now);
	// DAY ROLLOVER. A checkpoint from a previous UTC day starts today at zero —
	// the resume path, and the reason the walker survives being re-driven days
	// later by the stuck-send watchdog.
	const isSameDay = state.planDayKey !== undefined && state.planDayKey === dayKey && dayKey !== '';
	const enqueuedToday = isSameDay ? sanitizeCount(state.enqueuedToday) : 0;
	// The index counts the days the PLAN WAS ACTIVE ON, not calendar days elapsed:
	// a walk re-driven two days later resumes as the next day of the plan, which
	// is what the operator-facing "day 2 of 4" means and what the slice budget
	// needs. Calendar arithmetic here would number a day nobody sent on.
	const storedIndex = sanitizeCount(state.planDayIndex);
	const dayIndex = state.planDayKey === undefined ? 0 : isSameDay ? storedIndex : storedIndex + 1;

	const isRemainingKnown = input.remaining !== undefined;
	const remaining = isRemainingKnown ? sanitizeCount(input.remaining) : 0;
	// The plan's LENGTH needs a denominator. Without one it is carried forward
	// from the checkpoint rather than invented, and the progress line degrades to
	// the single-day sentence.
	const schedule = isRemainingKnown
		? buildCapacitySchedule({
				audienceSize: remaining,
				remainingCapacityByDay: capacityByDay,
				now,
			})
		: { days: sanitizeCount(state.planTotalDays) };
	// TWO READINGS THAT MUST NOT BE CONFUSED.
	//
	// NO PROJECTION AT ALL (an empty array, or the planner's `days === 0`
	// "cannot be planned" sentinel) is UNKNOWN capacity: it yields NO budget, and
	// the walk proceeds exactly as the shipped single-day walker always has. A
	// measurement we could not take never withholds mail (plan D2).
	//
	// A PROJECTED ZERO for today is the opposite — a real reading that today's cap
	// is already spent — and it exhausts the day rather than waiving the budget.
	// Collapsing the two would let a cap-spent deployment empty a 20 000-recipient
	// campaign into a queue that expires it.
	const hasProjection = capacityByDay.length > 0 && (!isRemainingKnown || schedule.days > 0);
	const capacityToday = hasProjection ? sanitizeCount(capacityByDay[0]) : undefined;

	if (capacityToday === undefined) {
		return {
			dayKey,
			dayIndex,
			totalDays: schedule.days,
			remainingToday: undefined,
			capacityToday: undefined,
			isDayExhausted: false,
			resumeAt: undefined,
			enqueuedToday,
		};
	}

	const remainingToday = Math.max(0, capacityToday - enqueuedToday);
	const isDayExhausted = remainingToday <= 0 && (!isRemainingKnown || remaining > 0);
	return {
		dayKey,
		dayIndex,
		totalDays: Math.min(MAX_PLAN_DAYS, schedule.days),
		remainingToday,
		capacityToday,
		isDayExhausted,
		resumeAt: isDayExhausted ? nextUtcDayStart(now) : undefined,
		enqueuedToday,
	};
}

/** A recipient the walker can order. Only the score is read. */
export interface EngagementOrdered {
	readonly engagementScore?: number | undefined;
}

/**
 * ENGAGEMENT ORDER — best remaining audience first (plan P0-2/P0-3).
 *
 * Each day's slice should be the best audience still unsent: it is what a
 * warming IP wants (engaged recipients open, and openers are what receivers
 * read as a positive signal) and it is what the recipient wants (the people who
 * asked for this mail get it first).
 *
 * STABLE, and missing scores sort LAST rather than first: an unscored contact is
 * not evidence of engagement, and a sort that promoted them would fill day one
 * with exactly the recipients we know least about. `Array.prototype.sort` is
 * specified stable, so equal scores keep the audience's own order.
 */
export function orderByEngagement<T extends EngagementOrdered>(recipients: readonly T[]): T[] {
	return [...recipients].sort((a, b) => engagementRank(b) - engagementRank(a));
}

function engagementRank(recipient: EngagementOrdered): number {
	const score = recipient.engagementScore;
	return score !== undefined && Number.isFinite(score) ? score : -1;
}

/**
 * THE OPERATOR-FACING PROGRESS STATE — "Sending over 4 days · day 1 of 4 · 5 000
 * of 20 000", present FROM THE MOMENT THE SEND STARTS (plan D14).
 *
 * A multi-day send is a normal, visible state for a warming deployment. It is
 * NEVER an error state and never a warning: this function has no failure shape
 * at all, and a plan it cannot describe degrades to the single-day sentence
 * rather than to a nag.
 */
export interface CampaignSendPlanProgress {
	/** Render the day-of-N line at all? False for an ordinary same-day send. */
	readonly isMultiDay: boolean;
	/** 1-based day being sent right now. Always at least 1. */
	readonly day: number;
	/** Days the plan spans. Always at least 1. */
	readonly totalDays: number;
	readonly enqueued: number;
	readonly total: number;
	/** The plan is longer than `MAX_PLAN_DAYS`: the copy says "more than N days". */
	readonly isTruncated: boolean;
}

export function campaignSendPlanProgress(input: {
	readonly planDayIndex: number | undefined;
	readonly planTotalDays: number | undefined;
	readonly enqueuedCount: number | undefined;
	readonly plannedTotal: number | undefined;
}): CampaignSendPlanProgress {
	const totalDays = Math.max(1, sanitizeCount(input.planTotalDays));
	const day = Math.min(totalDays, Math.max(1, sanitizeCount(input.planDayIndex) + 1));
	return {
		isMultiDay: totalDays > 1,
		day,
		totalDays,
		enqueued: sanitizeCount(input.enqueuedCount),
		total: sanitizeCount(input.plannedTotal),
		isTruncated: sanitizeCount(input.planTotalDays) >= MAX_PLAN_DAYS,
	};
}
