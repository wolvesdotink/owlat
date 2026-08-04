/**
 * Ramp controller — THE MEASUREMENT SHAPES (plan D12).
 *
 * A verdict is never a boolean: it carries the numbers that produced it, and the
 * audit row and the dashboard both render them. That makes the SHAPE of a
 * measurement a contract rather than an object literal, and a contract written
 * out by hand at each gate is a contract that grows a field in three places and
 * loses it in the fourth.
 *
 * Only the ONE-ARMED shape lives here. The ceiling cascade and the engagement
 * comparison each build a shape once for a whole family of gates, so they need no
 * helper; the one-armed gates — the deferral rate and the block-message hard stop
 * — are two independent call sites of the same six fields, and were already
 * drifting.
 *
 * PURE, like everything else under `ramp/`.
 */

/**
 * What a gate with NO second series reports. `referenceRate`, `referenceSample`
 * and `toleranceValuePp` are structurally `null` rather than merely absent: a
 * one-armed gate has no comparison, and a renderer must be able to tell "no
 * second arm by design" from "a second arm we could not measure".
 */
export interface OneArmedMeasurementShape {
	readonly referenceRate: null;
	readonly thresholdRate: number;
	readonly toleranceValuePp: null;
	readonly ownSample: number;
	readonly referenceSample: null;
	readonly minSample: number;
}

export function oneArmedMeasurement(args: {
	/** The absolute threshold this gate compared against, as a fraction. */
	readonly thresholdRate: number;
	readonly ownSample: number;
	readonly minSample: number;
}): OneArmedMeasurementShape {
	return {
		referenceRate: null,
		thresholdRate: args.thresholdRate,
		toleranceValuePp: null,
		ownSample: args.ownSample,
		referenceSample: null,
		minSample: args.minSample,
	};
}
