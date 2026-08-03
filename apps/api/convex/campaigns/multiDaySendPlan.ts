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
 * THE BUDGET AND THE PLAN LENGTH ARE TWO DIFFERENT QUESTIONS, and only the
 * second one needs a denominator. "How many may go out today" is
 * `capacityByDay[0]` minus what today has already carried — no audience size is
 * involved. "How many days will this take" needs to know how many recipients are
 * left, and that count is frequently a LOWER BOUND (`countAudience` stops at a
 * read budget). A lower bound LENGTHENS a plan; it must never be allowed to
 * cancel today's budget, because the campaigns whose count truncates are exactly
 * the large ones this feature exists for.
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
import { normalizeEngagementScore } from '../delivery/workerEnvelope';

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
	/**
	 * That plan left recipients UNSCHEDULED at `MAX_PLAN_DAYS` — the copy says
	 * "more than N days" rather than quoting a finish.
	 *
	 * Carried rather than re-derived from `planTotalDays >= MAX_PLAN_DAYS`,
	 * because a plan that covers the audience EXACTLY on day `MAX_PLAN_DAYS` is
	 * complete: the length alone cannot tell the two apart, and describing a
	 * finished plan as "more than 60 days" is the D14 dishonesty this whole
	 * module exists to avoid.
	 *
	 * `undefined` READS AS NOT TRUNCATED — the reading every pre-migration row
	 * gets, and every row this build has not hopped since. A checkpoint that
	 * really is truncated says so again the moment its next hop recomputes the
	 * length, so the stale reading is bounded by one cap window and costs a hedge
	 * on the copy, not a scheduling decision.
	 */
	readonly isPlanTruncated: boolean | undefined;
	/**
	 * The audience size the plan was built from — the progress line's
	 * denominator. Travels WITH the four counters above because it is read and
	 * written with them on every hop; keeping it out of the type left the
	 * checkpoint mutation restating a clump the type already described.
	 */
	readonly plannedTotal: number | undefined;
	/**
	 * `plannedTotal` is a LOWER BOUND rather than the audience size — the bounded
	 * count stopped at a ceiling or ran out of read budget. The plan is then AT
	 * LEAST as long as it computes, and the copy says so (plan D14).
	 */
	readonly isPlannedTotalLowerBound: boolean | undefined;
}

/**
 * HOW MANY RECIPIENTS ARE STILL TO ENQUEUE — and how well we know it.
 *
 * `unknown` and `atLeast` are deliberately different from `exact`: an audience
 * count that stopped early bounds the audience from BELOW, so it may lengthen a
 * plan and may never shorten one. Collapsing the three into a number is what let
 * a truncated count read as "nothing left to send" and waive the day budget on
 * exactly the campaigns the plan exists for.
 */
export type RemainingRecipients =
	| { readonly kind: 'unknown' }
	| { readonly kind: 'atLeast'; readonly count: number }
	| { readonly kind: 'exact'; readonly count: number };

export interface SendPlanSliceInput {
	readonly state: SendPlanState;
	/**
	 * Recipients still to enqueue. UNKNOWN NEVER WAIVES THE DAY BUDGET: the
	 * walker only asks while it still has pages to enqueue, so "how many are
	 * left" being unknown means "at least one".
	 */
	readonly remaining: RemainingRecipients;
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
	/** `totalDays` does not cover the audience — see `SendPlanState`. */
	readonly isTruncated: boolean;
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
 * What the walk still has to enqueue, derived from the checkpointed denominator.
 *
 * A denominator that was never taken answers `unknown`; one taken from a count
 * that stopped early answers `atLeast`. Only an exact count can say "nothing is
 * left", and only an exact count is allowed to stand the day budget down on that
 * basis.
 */
export function remainingRecipients(
	state: SendPlanState,
	enqueuedCount: number
): RemainingRecipients {
	// A denominator we cannot read is one we never took: a `NaN` that fell through
	// as `exact: 0` would say "the audience is finished" and stand the day budget
	// down — the exact failure this type exists to prevent.
	if (state.plannedTotal === undefined || !Number.isFinite(state.plannedTotal)) {
		return { kind: 'unknown' };
	}
	const count = Math.max(0, sanitizeCount(state.plannedTotal) - sanitizeCount(enqueuedCount));
	return state.isPlannedTotalLowerBound === true
		? { kind: 'atLeast', count }
		: { kind: 'exact', count };
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
	const { state, capacityByDay, remaining, now } = input;
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

	// THE PLAN'S LENGTH — the ONLY question a denominator is needed for. Its
	// truncation travels with it: the two are one answer from one schedule, and
	// deriving the second from the first is what let a complete plan claim it
	// runs past the day it finishes on.
	const length = planLength({
		remaining,
		capacityByDay,
		carried: {
			totalDays: sanitizeCount(state.planTotalDays),
			isTruncated: state.isPlanTruncated === true,
		},
		now,
	});

	// TWO READINGS THAT MUST NOT BE CONFUSED.
	//
	// NO PROJECTION AT ALL (an empty array) is UNKNOWN capacity: it yields NO
	// budget, and the walk proceeds exactly as the shipped single-day walker
	// always has. A measurement we could not take never withholds mail (plan D2).
	//
	// A PROJECTED ZERO for today is the opposite — a real reading that today's cap
	// is already spent — and it exhausts the day rather than waiving the budget.
	// Collapsing the two would let a cap-spent deployment empty a 20 000-recipient
	// campaign into a queue that expires it.
	//
	// THE PLAN'S LENGTH IS NOT PART OF THIS TEST. It used to be, and that is what
	// let a truncated audience count — which yields the planner's "cannot be
	// planned" sentinel — silently waive the budget on the largest campaigns.
	const hasProjection = capacityByDay.length > 0;
	const capacityToday = hasProjection ? sanitizeCount(capacityByDay[0]) : undefined;

	// AN EXACT DENOMINATOR THAT SAYS NOTHING IS LEFT stands the budget down. The
	// pages that remain are ones the count did not consider eligible, so metering
	// them against a spent day budget would crawl the tail one candidate per hop.
	// Only `exact` may do this: a lower bound reading "0 left" means only "the
	// count stopped", never "the audience is finished".
	const isAudienceCounted = remaining.kind === 'exact' && remaining.count === 0;
	if (capacityToday === undefined || isAudienceCounted) {
		return {
			dayKey,
			dayIndex,
			totalDays: length.totalDays,
			isTruncated: length.isTruncated,
			remainingToday: undefined,
			capacityToday,
			isDayExhausted: false,
			resumeAt: undefined,
			enqueuedToday,
		};
	}

	const remainingToday = Math.max(0, capacityToday - enqueuedToday);
	const isDayExhausted = remainingToday <= 0;
	return {
		dayKey,
		dayIndex,
		totalDays: length.totalDays,
		isTruncated: length.isTruncated,
		remainingToday,
		capacityToday,
		isDayExhausted,
		resumeAt: isDayExhausted ? nextUtcDayStart(now) : undefined,
		enqueuedToday,
	};
}

/** How long the plan is, and whether that length covers the audience. */
interface PlanLength {
	readonly totalDays: number;
	readonly isTruncated: boolean;
}

/**
 * How many days the plan spans, given what we know about how many recipients
 * are left. An unknown denominator carries the checkpoint's length forward
 * rather than inventing one; a LOWER-BOUND denominator computes a length that
 * can only be too short, so it may lengthen the plan and never shorten it.
 *
 * TRUNCATION COMES FROM THE SCHEDULE, never from comparing the length against
 * `MAX_PLAN_DAYS`: `buildCapacitySchedule` knows whether recipients were left
 * over, and a plan that covers its audience exactly on day `MAX_PLAN_DAYS` is
 * complete.
 */
function planLength(args: {
	readonly remaining: RemainingRecipients;
	readonly capacityByDay: readonly number[];
	readonly carried: PlanLength;
	readonly now: number;
}): PlanLength {
	const { remaining, capacityByDay, carried, now } = args;
	if (remaining.kind === 'unknown') return carried;
	const schedule = buildCapacitySchedule({
		audienceSize: remaining.count,
		remainingCapacityByDay: capacityByDay,
		now,
	});
	// `days === 0` is the planner's "cannot be planned" sentinel — no usable
	// projection, or one that plateaus at zero before the audience is covered.
	// That is an UNKNOWN length, so the checkpoint's reading is carried forward
	// whole rather than split across a carried length and a fresh truncation.
	if (schedule.days <= 0) return carried;
	const computed: PlanLength = {
		totalDays: Math.min(MAX_PLAN_DAYS, schedule.days),
		isTruncated: schedule.truncated,
	};
	if (remaining.kind !== 'atLeast') return computed;
	// A floor may only ever lengthen the plan, and truncation is the extreme of
	// length: a truncation one floor already established is not withdrawn by the
	// next floor, which is measuring an audience that can only be larger.
	return {
		totalDays: Math.max(carried.totalDays, computed.totalDays),
		isTruncated: carried.isTruncated || computed.isTruncated,
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

/**
 * THE SAME BAND RULE THE OTHER TWO READERS OF THE STORED SCORE APPLY — the
 * dispatch envelope and the stratified assignment ranker both read it through
 * `normalizeEngagementScore`. A stored `250` is an upstream scorer defect, not
 * a very engaged contact; ranked on its face it would take the front of day
 * one's slice on the same send whose envelope drops it as unknown.
 *
 * A refused score sorts LAST, where the unscored already are: the rule for "no
 * usable evidence of engagement" is one rule.
 */
function engagementRank(recipient: EngagementOrdered): number {
	return normalizeEngagementScore(recipient.engagementScore) ?? -1;
}
