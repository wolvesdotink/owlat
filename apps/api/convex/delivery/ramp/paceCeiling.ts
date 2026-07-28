/**
 * WHERE THE MULTIPLIER BECOMES A CAP — and the ONE place the published base
 * warming schedule is applied as a HARD CEILING (plan D19).
 *
 *   dailyCap(cell) = clamp(dailyCap(cell) * m, floor, BASE_SCHEDULE_CEILING(day))
 *
 * The controller may go SLOWER than the published ramp; it may never go faster
 * than its ceiling for the current day. Keeping that clamp in one function —
 * rather than in the actuator, which only moves a dial — is what makes the
 * property checkable: no rung of `nextPaceMultiplier` computes a cap, so no rung
 * of it can exceed the schedule.
 *
 * AND THE CAP DOES NOT GROW BEYOND WHAT VOLUME CAN ACTUALLY EXERCISE. An
 * unexercised cap is not evidence that a bigger one is safe, so growth tracks
 * demand: the cap may exceed the volume recently exercised by
 * `exerciseHeadroom` and no more. ABSENCE OF THE READING IS NOT A CONSTRAINT
 * (plan D2): a deployment we have no volume history for is bounded by the
 * published schedule alone, never by a zero we invented.
 *
 * Pure: every input is a parameter.
 */

import { PACE_AIMD } from './paceConfig';

export interface EffectiveDailyCapInput {
	/**
	 * The cap the shipped warming schedule publishes for the cell's CURRENT
	 * schedule day. This is the hard ceiling; `Infinity` means graduated.
	 */
	readonly baseScheduleCap: number;
	/** The pace multiplier in force, already sanitised by the actuator. */
	readonly multiplier: number;
	/**
	 * The largest volume actually sent against the cap in the recent window, or
	 * `undefined` when there is no reading. Absence never constrains (plan D2).
	 */
	readonly exercisedVolume?: number | undefined;
}

/**
 * The cap the pace actuator's multiplier produces, with both bounds applied.
 *
 * A degenerate base cap answers with the policy minimum rather than with `NaN`
 * or zero: the cap is what stands between the deployment and sending nothing at
 * all, and a reading we cannot use is not a reason to stop.
 */
export function effectiveDailyCap(input: EffectiveDailyCapInput): number {
	const { baseScheduleCap, multiplier, exercisedVolume } = input;
	// GRADUATED. The published schedule imposes no ceiling, so neither does this:
	// an `Infinity` ceiling multiplied by a dial is still `Infinity`, and bounding
	// it by exercised volume would re-impose a cap the IP has already outgrown.
	if (baseScheduleCap === Infinity) return Infinity;
	if (!Number.isFinite(baseScheduleCap) || baseScheduleCap <= 0) {
		return PACE_AIMD.minimumDailyCap;
	}
	const dial = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

	// What the dial ASKS for. It may legitimately exceed the day's ceiling — the
	// dial is a request, and the clamp below is the answer.
	const requested = baseScheduleCap * dial;

	// THE EXERCISE BOUND. Only a real, positive reading constrains; the floor on
	// it is what stops a quiet day pinning the cap somewhere the cell could never
	// generate the volume to climb back from.
	const exercised =
		exercisedVolume !== undefined && Number.isFinite(exercisedVolume) && exercisedVolume > 0
			? Math.max(PACE_AIMD.minimumDailyCap, exercisedVolume * PACE_AIMD.exerciseHeadroom)
			: Infinity;

	// THE HARD CEILING. Applied here, and here only — and applied LAST, so no
	// floor above can lift a cap past the schedule's ceiling for the day.
	const bounded = Math.min(baseScheduleCap, requested, exercised);
	// Never zero: a cap of nothing sends nothing, and a cell that sends nothing
	// can never be re-measured. One send is the trickle, the same rule the share
	// floor follows.
	return Math.min(baseScheduleCap, Math.max(1, Math.floor(bounded)));
}
