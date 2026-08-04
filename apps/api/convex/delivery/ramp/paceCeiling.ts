/**
 * WHERE THE MULTIPLIER BECOMES A CAP — and the ONE place the published base
 * warming schedule is applied as a HARD CEILING (plan D19).
 *
 *   dailyCap(cell) = clamp(dailyCap(cell) * m, floor, BASE_SCHEDULE_CEILING(day))
 *
 * TWO DIFFERENT CAPS APPEAR IN THAT LINE, and conflating them makes the dial's
 * whole increase range inert:
 *
 *   · `cellCap` is the per-(IP x mailboxProvider) cap the cell actually sends
 *     against — the IP's daily cap narrowed by the provider's own multiplier
 *     (`warmingProviderStore.providerCapVerdict`). THIS is what the dial
 *     multiplies, and it is the number the plan means by `dailyCap(cell)`.
 *   · `baseScheduleCap` is the IP's PUBLISHED schedule cap for the current
 *     schedule day. That is the HARD CEILING: the controller may go slower than
 *     the published ramp, and may never exceed it for the day.
 *
 * Because the cell cap sits BELOW the IP's published cap, a multiplier above 1
 * buys real per-provider headroom — up to the IP's own cap and not one send
 * further. Multiplying the ceiling by the dial and then clamping to the same
 * ceiling, as an earlier revision did, made every increase a no-op and turned the
 * AIMD asymmetry upside down (a halving of an inert dial is not a halving of
 * anything).
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
 * `CAP_EXERCISE_HEADROOM` and no more. ABSENCE OF THE READING IS NOT A
 * CONSTRAINT (plan D2): a deployment we have no volume history for is bounded by
 * the published schedule alone, never by a zero we invented.
 *
 * Pure: every input is a parameter.
 */

/**
 * How far past the volume actually exercised a cap may be allowed to grow. A cap
 * nobody filled is not evidence that a bigger one is safe, so growth tracks
 * demand: today's cap may exceed the recently exercised volume by this factor
 * and no more.
 *
 * Lives here rather than with the actuator's AIMD bounds because it shapes a
 * CAP, not the dial: nothing in `nextPaceMultiplier` reads it, and the two are
 * changed for entirely different reasons.
 */
const CAP_EXERCISE_HEADROOM = 1.5;

/**
 * The smallest daily cap the exercise bound may produce. Without it a day with a
 * handful of sends would pin the cap near zero and the cell could never generate
 * the volume that would lift it again.
 */
const MINIMUM_DAILY_CAP = 50;

export interface EffectiveDailyCapInput {
	/**
	 * The per-(IP x mailboxProvider) cap the cell sends against today, BEFORE the
	 * pace dial. This is what the multiplier multiplies.
	 */
	readonly cellCap: number;
	/**
	 * The cap the shipped warming schedule publishes for the IP's CURRENT
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
 * A degenerate cell cap answers with the policy minimum rather than with `NaN`
 * or zero: the cap is what stands between the deployment and sending nothing at
 * all, and a reading we cannot use is not a reason to stop.
 */
export function effectiveDailyCap(input: EffectiveDailyCapInput): number {
	const { cellCap, baseScheduleCap, multiplier, exercisedVolume } = input;
	// GRADUATED, and no cell cap either: the published schedule imposes no ceiling
	// and there is nothing to multiply, so neither does this. Bounding it by
	// exercised volume would re-impose a cap the IP has already outgrown.
	//
	// `cellCap === Infinity` AND NOT `!Number.isFinite(cellCap)`. The intent is
	// GRADUATED — a cap that is known to be unbounded — and `NaN` is not that: it
	// is a reading we could not use, and everywhere else in this module a reading
	// we cannot use fails CLOSED. A ceiling that "does not bind" is deliberate; an
	// unbounded CAP produced from an unreadable number is not, so a `NaN` cell cap
	// falls through to the policy minimum below.
	if (baseScheduleCap === Infinity && cellCap === Infinity) return Infinity;
	// The CEILING. A ceiling we cannot read is not a ceiling — an unreadable
	// published cap must not silently pin the cell to the policy minimum, so it
	// simply does not bind.
	const ceiling =
		Number.isFinite(baseScheduleCap) && baseScheduleCap > 0 ? baseScheduleCap : Infinity;
	if (!Number.isFinite(cellCap) || cellCap <= 0) {
		return Math.min(ceiling, MINIMUM_DAILY_CAP);
	}
	const dial = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;

	// What the dial ASKS for. It may legitimately exceed the day's ceiling — the
	// dial is a request, and the clamp below is the answer.
	const requested = cellCap * dial;

	// THE EXERCISE BOUND. Only a real, positive reading constrains; the floor on
	// it is what stops a quiet day pinning the cap somewhere the cell could never
	// generate the volume to climb back from.
	const exercised =
		exercisedVolume !== undefined && Number.isFinite(exercisedVolume) && exercisedVolume > 0
			? Math.max(MINIMUM_DAILY_CAP, exercisedVolume * CAP_EXERCISE_HEADROOM)
			: Infinity;

	// THE HARD CEILING. Applied here, and here only — and applied LAST, so no
	// floor above can lift a cap past the schedule's ceiling for the day.
	const bounded = Math.min(ceiling, requested, exercised);
	if (!Number.isFinite(bounded)) return Infinity;
	// Never zero: a cap of nothing sends nothing, and a cell that sends nothing
	// can never be re-measured. One send is the trickle, the same rule the share
	// floor follows.
	return Math.min(ceiling, Math.max(1, Math.floor(bounded)));
}
