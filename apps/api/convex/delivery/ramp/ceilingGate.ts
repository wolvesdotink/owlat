/**
 * THE CEILING GATE — one cascade, four specs (plan D15).
 *
 * Gates 1 and 3 are the same gate with different numbers: "the own arm is under
 * an absolute ceiling AND is not worse than the series we compare it against".
 * The reference-arm evaluator compares against the concurrent relay arm; the
 * standalone one compares against the cell's own 30-day trailing window. That is
 * a difference in WHICH SERIES and IN WHAT UNIT, not a difference in the safety
 * cascade — so the cascade lives here exactly once and the four differences are
 * data.
 *
 * The ordering below IS the safety property. Two copies of it would be two
 * chances to get clock skew, a thin sample or an absent second series subtly
 * different, and they would disagree only in production — which is precisely the
 * degraded-path rot this module exists to prevent.
 *
 * PURE (plan D15): `now` is a parameter, nothing reads a clock, a database or the
 * environment.
 */

import { ppToFraction } from './gateConfig';
import type {
	PercentagePoints,
	RampGateSampleFloors,
	RampGateThresholds,
	RateFraction,
} from './gateConfig';
import {
	armEvidence,
	evidenceReason,
	insufficient,
	notADenominatorReason,
	safeRate,
} from './gateEvidence';
import type {
	RampGateDecidedMeasurement,
	RampGateEvaluationInput,
	RampGateGrade,
	RampGateId,
	RampGateResult,
} from './gateTypes';
import { safeOutcomeCount } from '../../analytics/transportOutcomeSummary';
import type { TransportOutcomeSummary } from '../../analytics/transportOutcomeSummary';

/**
 * The comparative half of a two-armed gate: is the own arm within `tolerance`
 * PERCENTAGE POINTS of the second series?
 *
 * Exported because gate 5 (seed placement) applies the same allowance with the
 * opposite polarity — high is GOOD for inbox placement — and one conversion is
 * one chance to get it wrong.
 *
 * The pp -> fraction conversion happens HERE and only here, so no caller can
 * accidentally compare a percentage-point tolerance against a rate fraction.
 */
export function withinTolerance(
	ownRate: number,
	referenceRate: number,
	tolerance: PercentagePoints,
	direction: 'own_must_not_exceed' | 'own_must_not_fall_below'
): boolean {
	const toleranceFraction = ppToFraction(tolerance) as number;
	return direction === 'own_must_not_exceed'
		? ownRate <= referenceRate + toleranceFraction
		: ownRate >= referenceRate - toleranceFraction;
}

export interface CeilingGateSpec {
	readonly gate: Extract<RampGateId, 'hard_bounce' | 'complaint'>;
	readonly rateOf: (summary: TransportOutcomeSummary) => number;
	/**
	 * The absolute ceiling, or `null` for a gate that has none. The standalone
	 * complaint PROXY is the only `null`: unsubscribe rates run an order of
	 * magnitude above complaint rates, so the absolute complaint ceiling applied to
	 * them would fail every healthy cell. It compares only against the cell's own
	 * trailing rate.
	 */
	readonly thresholdOf: (thresholds: RampGateThresholds) => RateFraction | null;
	readonly floorOf: (floors: RampGateSampleFloors) => number;
	/**
	 * The comparative half, or `null` for a gate that is absolute-only (the
	 * standalone complaint gate when a feedback loop IS present: real complaint
	 * reports need no second series to mean something).
	 *
	 * A spec with neither a threshold nor a second series would pass unconditionally
	 * and is a defect; `ceilingGateSpecIsDecidable` states that invariant and
	 * `gates.units.test.ts` asserts it over every shipped spec, in both matrix legs.
	 */
	readonly secondSeries: CeilingSecondSeries | null;
	readonly grade: RampGateGrade;
}

/**
 * The series a ceiling gate compares its own arm against, and how.
 *
 * Bundled rather than spread across four sibling fields because they are only
 * ever meaningful together: an arm vocabulary, an age allowance and a sample
 * floor with no series to apply them to is four chances to describe a comparison
 * that is not happening.
 */
export interface CeilingSecondSeries {
	/** The concurrent reference arm, or — standalone — the cell's own past. */
	readonly of: (input: RampGateEvaluationInput) => TransportOutcomeSummary | null;
	/** Which vocabulary a hold speaks (`gateEvidence.evidenceReason`). */
	readonly arm: 'reference' | 'baseline';
	/** How old it may be. A trailing window is old BY CONTRACT (`maxBaselineAgeMs`). */
	readonly maxAgeOf: (thresholds: RampGateThresholds) => number;
	readonly floorOf: (floors: RampGateSampleFloors) => number;
	readonly comparison: CeilingComparison;
}

/**
 * How the comparative half is expressed. Two units, never interchangeable:
 * `tolerance_pp` is an ADDITIVE allowance in percentage points (the reference-arm
 * gates), `multiple` is a dimensionless RELATIVE ceiling (the standalone
 * substitutions). Modelling them as a discriminated union rather than as two
 * nullable number fields is what stops a 1.5 from ever being read as 1.5pp.
 */
export type CeilingComparison =
	| { readonly kind: 'tolerance_pp'; readonly of: (t: RampGateThresholds) => PercentagePoints }
	| {
			readonly kind: 'multiple';
			readonly of: (t: RampGateThresholds) => number;
			/**
			 * WHICH SIDE THE BOUNDARY ITSELF FALLS ON, because the plan's two
			 * substitutions state it differently and one shared operator cannot be
			 * right for both.
			 *
			 *  - `inclusive_pass` — the plan says gate 1 allows "AT MOST 1.5x the
			 *    cell's own trailing rate", so exactly 1.5x PASSES (`own <= k*base`).
			 *  - `inclusive_fail` — the plan says gate 3's unsubscribe proxy breaches
			 *    "AT OR ABOVE 3x the trailing baseline", so exactly 3.0x FAILS
			 *    (`own < k*base` to pass).
			 *
			 * Stated on the comparison rather than left to whichever operator the
			 * cascade happens to use: a single `<=` shared by both would silently
			 * move one of the plan's two thresholds by one send.
			 */
			readonly boundary: 'inclusive_pass' | 'inclusive_fail';
	  };

/**
 * A ceiling gate must be able to FAIL something. A spec with no absolute ceiling
 * and no second series can only ever pass, which is worse than having no gate at
 * all — it looks like evidence.
 */
export function ceilingGateSpecIsDecidable(
	spec: CeilingGateSpec,
	thresholds: RampGateThresholds
): boolean {
	return spec.thresholdOf(thresholds) !== null || spec.secondSeries !== null;
}

/**
 * ORDERING, and why:
 *   1. Own arm thin/stale -> insufficient_data. We know nothing.
 *   2. Own arm over the absolute ceiling -> fail, EVEN IF the reference arm is
 *      thin or absent. A 20% hard-bounce rate on ample own-arm data is real
 *      evidence; making it wait for the relay's sample would be a safety hole,
 *      and plan D2 forbids an external account being load-bearing — including
 *      load-bearing for a RETREAT.
 *   3. Reference arm thin/stale/absent -> insufficient_data. The comparative
 *      half is unmeasurable, so the gate holds rather than passing on half a
 *      check.
 *   4. A RELATIVE ceiling whose second series cannot act as a denominator ->
 *      insufficient_data, reported as `*_not_a_denominator` and NOT as
 *      `*_rate_unmeasurable`: the rate is a real number, it is the derived
 *      ceiling that cannot decide. See `relativeCeilingIsMeasurable`.
 *   5. Otherwise, compare the arms.
 */
export function evaluateCeilingGate(
	spec: CeilingGateSpec,
	input: RampGateEvaluationInput
): RampGateResult {
	const { thresholds, sampleFloors } = input.config;
	const minSample = spec.floorOf(sampleFloors);
	const threshold = spec.thresholdOf(thresholds);
	const series = spec.secondSeries;
	const second = series ? series.of(input) : null;
	const secondMinSample = series ? series.floorOf(sampleFloors) : 0;

	const ownSample = safeOutcomeCount(input.own.sent);
	const secondSample = second ? safeOutcomeCount(second.sent) : null;
	const ownRate = safeRate(spec.rateOf(input.own));
	const secondRate = second ? safeRate(spec.rateOf(second)) : null;
	const comparison = series?.comparison ?? null;

	/**
	 * A relative-only gate reports `thresholdRate: 0` until the second series is
	 * accepted, exactly as gate 4 does: its effective ceiling IS a multiple of that
	 * series' rate, and a number derived from evidence the gate has just refused to
	 * use is a number an operator would read off the dashboard as the live one.
	 */
	const shape = {
		thresholdRate: (threshold as number | null) ?? 0,
		toleranceValuePp:
			comparison?.kind === 'tolerance_pp' ? (comparison.of(thresholds) as number) : null,
		...(comparison?.kind === 'multiple' ? { ratioCeiling: comparison.of(thresholds) } : {}),
		ownSample,
		referenceSample: secondSample,
		minSample,
		...(series === null ? {} : { referenceMinSample: secondMinSample }),
	} as const;

	const ownEvidence = armEvidence(
		input.own,
		ownSample,
		minSample,
		input.now,
		thresholds,
		thresholds.maxEvidenceAgeMs
	);
	if (ownEvidence !== 'fresh' || ownRate === null) {
		return insufficient(
			spec.gate,
			evidenceReason(ownEvidence, 'own'),
			{ ...shape, ownRate, referenceRate: secondRate },
			spec.grade
		);
	}

	if (threshold !== null && ownRate > (threshold as number)) {
		return {
			gate: spec.gate,
			status: 'fail',
			reason: 'absolute_threshold_breached',
			measurement: { ...shape, ownRate, referenceRate: secondRate },
			...spec.grade,
		};
	}

	// An absolute-only gate has nothing left to consult: the own arm is fresh,
	// large enough and under the ceiling, which is the whole check.
	if (series === null || comparison === null) {
		return {
			gate: spec.gate,
			status: 'pass',
			reason: 'within_threshold',
			measurement: { ...shape, ownRate, referenceRate: secondRate },
			...spec.grade,
		};
	}

	const secondEvidence = armEvidence(
		second,
		secondSample ?? 0,
		secondMinSample,
		input.now,
		thresholds,
		series.maxAgeOf(thresholds)
	);
	if (secondEvidence !== 'fresh' || secondRate === null) {
		return insufficient(
			spec.gate,
			evidenceReason(secondEvidence, series.arm),
			{ ...shape, ownRate, referenceRate: secondRate },
			spec.grade
		);
	}

	if (comparison.kind === 'tolerance_pp') {
		return decide(
			spec,
			withinTolerance(ownRate, secondRate, comparison.of(thresholds), 'own_must_not_exceed'),
			'reference_tolerance_breached',
			{ ...shape, ownRate, referenceRate: secondRate }
		);
	}

	// With the second series accepted, a relative gate can finally state the
	// ceiling it actually applied.
	const ceiling = secondRate * comparison.of(thresholds);
	if (!relativeCeilingIsMeasurable(secondRate, ceiling, threshold)) {
		return insufficient(
			spec.gate,
			notADenominatorReason(series.arm),
			{ ...shape, ownRate, referenceRate: secondRate },
			spec.grade
		);
	}

	return decide(
		spec,
		comparison.boundary === 'inclusive_pass' ? ownRate <= ceiling : ownRate < ceiling,
		'trailing_baseline_breached',
		{ ...shape, thresholdRate: ceiling, ownRate, referenceRate: secondRate }
	);
}

/**
 * CAN A RELATIVE CEILING BE COMPUTED FROM THIS SERIES, AND CAN THE RESULT FAIL
 * ANYTHING? Two ways it cannot, and both must HOLD rather than decide (plan D10).
 *
 * 1. A ZERO SECOND RATE IS A DIVISION BY ZERO WEARING A MULTIPLICATION'S CLOTHES.
 *    `safeRate(0)` is a perfectly good rate and `armEvidence` only counts SENDS,
 *    so a 40k-send trailing window with no hard bounces at all is fresh,
 *    large-enough evidence with a rate of zero — and `k * 0` is a ceiling nothing
 *    can be under. A cell that bounced one recipient in ten thousand, two orders
 *    of magnitude inside the absolute ceiling, would be failed for it and halved.
 *    Young and low-volume cells reach a zero-rate month routinely, and they are
 *    exactly the population the standalone substitutions exist for.
 *    `evaluateEngagementComparison` already refuses a zero denominator for the
 *    same reason; this is that rule, on this side of the cascade.
 * 2. A CEILING NOTHING CAN BREACH IS NOT A CEILING. A gate with no absolute
 *    threshold (the unsubscribe proxy) is relative-only, so a second series whose
 *    rate is high enough that `k * base` reaches 1 would pass every possible own
 *    rate — an unfalsifiable gate that still contributes `increaseEvidence` and
 *    still advances the clean streak. A poisoned or absurd baseline must buy
 *    silence, never permission.
 */
function relativeCeilingIsMeasurable(
	secondRate: number,
	ceiling: number,
	absoluteThreshold: RateFraction | null
): boolean {
	if (!(secondRate > 0)) return false;
	return absoluteThreshold !== null || ceiling < 1;
}

function decide(
	spec: CeilingGateSpec,
	within: boolean,
	failReason: 'reference_tolerance_breached' | 'trailing_baseline_breached',
	measurement: RampGateDecidedMeasurement
): RampGateResult {
	return within
		? {
				gate: spec.gate,
				status: 'pass',
				reason: 'within_threshold',
				measurement,
				...spec.grade,
			}
		: {
				gate: spec.gate,
				status: 'fail',
				reason: failReason,
				measurement,
				...spec.grade,
			};
}
