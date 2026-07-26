/**
 * Campaign capacity planner — the PURE decision function behind the binding
 * pre-flight capacity check (deliverability plan rev 3, P0-5).
 *
 * A warming deployment with no relay to overflow to can start a campaign it
 * provably cannot finish: the MTA hits the warming cap, defers the tail, and
 * the tail silently expires at `maxMessageAgeMs`. Rather than let that happen,
 * pre-flight refuses the send and hands back a multi-day SCHEDULE — capacity is
 * a schedule, not a failure (plan D2/D14 honesty rule).
 *
 * Purity is the point (D15): no `Date.now()`, no DB reads, no env reads. The
 * clock and every input are parameters, so the predicate is exhaustively
 * table-testable. The ctx-bound half (reading warming state, counting the
 * audience) lives in `capacityPreflight.ts`.
 *
 * Soundness rule: `remainingCapacityByDay` must be an UPPER bound on what the
 * deployment can send each day (the published warming schedule is a ceiling).
 * Refusing on an upper bound is sound — if the optimistic projection cannot
 * finish inside the retention horizon, neither can reality.
 */

/** Milliseconds in a UTC day — the granularity the warming cap resets on. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Hard bound on how many days a returned plan may span. A plan longer than
 * this is not a schedule anyone would accept; the slices are truncated and the
 * caller renders "N+ days".
 */
export const MAX_PLAN_DAYS = 60;

export interface CampaignCapacityPlanInput {
	/** Eligible recipients. A lower bound is fine — refusing on one is sound. */
	audienceSize: number;
	/**
	 * Projected sendable volume per day, index 0 = the REMAINDER of today,
	 * index k = the whole of the k-th day after today (UTC day boundaries).
	 */
	remainingCapacityByDay: readonly number[];
	/** How long a queued message survives before the MTA expires it. */
	maxMessageAgeMs: number;
	/** Current wall-clock time (ms since epoch). */
	now: number;
}

export type CampaignCapacityPlan =
	| { fits: true }
	| {
			fits: false;
			/**
			 * Days the send needs. `0` is the "cannot be planned" sentinel — no
			 * usable capacity was projected at all. Callers MUST treat `days === 0`
			 * as unknown capacity and ALLOW the send (never refuse on missing data).
			 */
			days: number;
			/** Per-day recipient slice sizes, `slices.length === days`. */
			slices: number[];
			/** Projected completion instant: the end of the last sliced day. */
			finishesAt: number;
	  };

/** Start of the UTC day containing `now`. */
function utcDayStart(now: number): number {
	return Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
}

/** Non-negative finite integer, or 0 for anything hostile (NaN, -1, Infinity). */
function sanitizeCount(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

/**
 * How many projected days are usable before a message queued *now* expires.
 * Day 0 (the remainder of today) is usable whenever the horizon is positive;
 * day k is usable when it STARTS before the expiry instant.
 */
export function usableDayCount(now: number, maxMessageAgeMs: number): number {
	if (!Number.isFinite(now) || !Number.isFinite(maxMessageAgeMs) || maxMessageAgeMs <= 0) return 0;
	const expiresAt = now + maxMessageAgeMs;
	const dayZeroStart = utcDayStart(now);
	let days = 1; // the remainder of today
	while (days < MAX_PLAN_DAYS && dayZeroStart + days * MS_PER_DAY < expiresAt) {
		days += 1;
	}
	return days;
}

/**
 * Decide whether a campaign can finish inside the message-retention horizon,
 * and if not, what the multi-day schedule looks like.
 *
 * Degenerate inputs deliberately answer `{ fits: true }` — an empty audience,
 * a hostile audience size, or a non-sensical retention horizon are never
 * grounds to block a send (D2: absence of measurement never blocks).
 */
export function planCampaignCapacity(input: CampaignCapacityPlanInput): CampaignCapacityPlan {
	const audienceSize = sanitizeCount(input.audienceSize);
	if (audienceSize === 0) return { fits: true };

	const capacities = input.remainingCapacityByDay.map(sanitizeCount);
	const horizonDays = usableDayCount(input.now, input.maxMessageAgeMs);
	if (horizonDays === 0) return { fits: true };

	// Does it finish inside the horizon? Only the days the message survives count.
	let withinHorizon = 0;
	for (let day = 0; day < horizonDays; day += 1) {
		withinHorizon += capacities[day] ?? 0;
		if (withinHorizon >= audienceSize) return { fits: true };
	}

	// It does not fit. Build the schedule over the full projection, extending
	// past the projected window at the last projected day's rate (the warming
	// schedule plateaus, so this neither invents growth nor pretends at zero).
	// A day with no capacity is still a real day of the schedule, so slices are
	// indexed by calendar day from today (a leading 0 means "nothing goes out
	// today"). The plan is truncated at MAX_PLAN_DAYS.
	const trailingRate = capacities.length > 0 ? (capacities[capacities.length - 1] ?? 0) : 0;
	const slices: number[] = [];
	let remaining = audienceSize;
	for (let day = 0; day < MAX_PLAN_DAYS && remaining > 0; day += 1) {
		const capacity = day < capacities.length ? (capacities[day] ?? 0) : trailingRate;
		const slice = Math.min(capacity, remaining);
		slices.push(slice);
		remaining -= slice;
	}

	// Trim trailing zero days so `days` is the day the last recipient goes out.
	while (slices.length > 0 && slices[slices.length - 1] === 0) slices.pop();

	// Nothing could be scheduled at all: no positive capacity anywhere. This is
	// the "cannot be planned" sentinel — callers hold and allow.
	if (slices.length === 0) {
		return { fits: false, days: 0, slices: [], finishesAt: input.now };
	}

	const days = slices.length;
	const finishesAt = utcDayStart(input.now) + days * MS_PER_DAY;
	return { fits: false, days, slices, finishesAt };
}
