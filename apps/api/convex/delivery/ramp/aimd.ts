/**
 * THE AIMD ARITHMETIC — one implementation, parameterised by bounds (plan D3,
 * D9).
 *
 * The controller has TWO actuators. With a reference transport it moves a SHARE
 * in [0, 1]; standalone (s === 1 by definition) it moves a WARMING-PACE
 * MULTIPLIER against the per-(IP x mailboxProvider) daily cap. Same gates, same
 * asymmetry, same guardrails — and therefore the same arithmetic. Two copies of
 * "halve it, but never below the floor" is how the two actuators come to
 * disagree about what a retreat costs, so there is exactly one copy and the
 * bounds are arguments.
 *
 * PURE and total: every function here takes numbers and returns a number.
 * Degenerate input FAILS CLOSED in the two functions that HAVE a floor to fail
 * to — `aimdClamp` and `aimdDecrease` both resolve a non-finite value to the
 * floor, the direction that cannot advance a cell. `aimdIncrease` has no floor
 * in its bounds by design and says at its own definition what it does instead.
 */

/** The bounds one actuator moves between. */
export interface AimdBounds {
	/** The value a SOFT failure may never fall below (never fully zero, D9). */
	readonly floor: number;
	/** The hard upper bound an increase may never exceed. */
	readonly ceiling: number;
	/** Additive increase per clean window, in the actuator's own units. */
	readonly step: number;
	/** Multiplicative decrease applied the instant any gate breaches. */
	readonly decreaseFactor: number;
}

/**
 * Clamp a stored value into its actuator's range. A non-finite reading lands on
 * the FLOOR: the one thing a value we cannot read must never buy is headroom.
 */
export function aimdClamp(value: number, floor: number, ceiling: number): number {
	if (!Number.isFinite(value)) return floor;
	if (value < floor) return floor;
	return value > ceiling ? ceiling : value;
}

/**
 * THE MULTIPLICATIVE DECREASE — cheap to retreat (plan D9).
 *
 * `floor` is passed rather than assumed because the two callers genuinely
 * differ: a gate breach retreats to the SOFT floor (keep a trickle so the cell
 * can be re-measured), while a hard stop retreats past it — that is what makes
 * a hard stop hard, and it is expressed by passing `floor: 0`.
 */
export function aimdDecrease(
	value: number,
	bounds: Pick<AimdBounds, 'floor' | 'decreaseFactor'>
): number {
	if (!Number.isFinite(value)) return bounds.floor;
	const factor = Number.isFinite(bounds.decreaseFactor) ? bounds.decreaseFactor : 0;
	return Math.max(bounds.floor, value * factor);
}

/**
 * THE ADDITIVE INCREASE — expensive to advance (plan D9), and bounded by the
 * ceiling in the same expression so no caller can add first and clamp later.
 *
 * Deliberately does NOT apply the floor: an increase that a floor had to rescue
 * is not an increase, and lifting a below-floor value here would turn the
 * "never fully zero" guarantee into a silent promotion. The floor belongs to
 * the retreat.
 */
export function aimdIncrease(value: number, bounds: Pick<AimdBounds, 'ceiling' | 'step'>): number {
	// A value we cannot read is returned UNTOUCHED — deliberately, and it is why
	// this function is excluded from the module's fail-closed promise. "Closed"
	// for an increase would mean the floor, and this function has no floor to
	// return: adding one would lift a below-floor value into a silent promotion,
	// which is the thing the doc above forbids. Both callers clamp the result
	// through `aimdClamp` (which does fail closed) before it can be stored, and
	// an unreadable value never compares greater than the value it came from, so
	// it can never buy a step.
	if (!Number.isFinite(value)) return value;
	const step = Number.isFinite(bounds.step) ? bounds.step : 0;
	const ceiling = Number.isFinite(bounds.ceiling) ? bounds.ceiling : value;
	return Math.min(ceiling, value + step);
}
