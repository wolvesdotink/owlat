/**
 * Gate 4 — THE ENGAGEMENT RATIO (plan D8, D10, D12, D14, D15).
 *
 * THE ANCHOR GATE. Absolute open rate is worthless as a deliverability metric:
 * it moves with subject line, audience and season, and a cell that drops from
 * 32% to 26% has told you nothing. The RATIO between two randomly-assigned arms
 * of the SAME send is not worthless — subject, content, timing and audience are
 * held constant by construction, so the only systematic difference left between
 * the arms is the transport.
 *
 *     R = engagementRate(own) / engagementRate(reference)  >=  0.95
 *
 * THREE things make this gate correct rather than merely plausible, and each of
 * them is a caveat that would silently invert the result if it were dropped:
 *
 * 1. CALIBRATION SLICE ONLY (plan D8). Assignment is STRATIFIED by default —
 *    the own arm gets the top engagement percentile first, because that is what
 *    warms an IP. Stratification is right for warming and fatal for comparison:
 *    it hands the own arm a systematically better audience, so the general
 *    counters would report the own arm winning no matter what the transport
 *    did. This gate therefore reads ONLY `calibrationSent`/`calibrationOpened`/
 *    `calibrationClicked` — the small purely-random slice that exists for
 *    exactly this purpose. Reading the general counters here is a DEFECT, not a
 *    shortcut, and `engagementRatioCalibration.test.ts` exists to catch it.
 *
 * 2. MPP AND PIXEL PROXYING (see `engagementConfig.ts`). Opens are inflated and
 *    distorted per provider, so the ratio is computed PER MAILBOX-PROVIDER CELL
 *    (inflation is roughly constant inside a cell and largely cancels in a
 *    ratio) and the Apple cell — where MPP pre-fetches every pixel — is gated on
 *    CLICK rate instead. That substitution is a configuration table, not an
 *    `if` in the arithmetic.
 *
 * 3. THE MINIMUM SAMPLE IS ENFORCED, NOT ADVISORY (plan D10). Below the floor
 *    the gate returns `insufficient_data` and the controller HOLDS: it never
 *    increases on thin data, and it never decreases on it either. A gate
 *    returning a verdict below its minimum sample is a defect.
 *
 * AND THE SLOW POISON. Every gate above is a comparison against something else
 * measured at the same time, which means reputation damage that accumulates
 * SMOOTHLY — a cell degrading a little every week, both arms drifting together,
 * nothing ever breaching a threshold — passes all of them. The absolute-floor
 * check is the only defence against that: the cell's RECENT window against its
 * own PRIOR 30-day window. It lives in this module because it shares the metric
 * substitution and the calibration restriction, and it only ever contributes a
 * FAIL (see `evaluateEngagementGate`), so a young cell with no baseline can
 * never be held back by it.
 *
 * ONE COMPARISON, TWO SPECS. Both sub-gates are the same cascade — resolve the
 * metric, take the two calibration sides, hold on unusable evidence, refuse a
 * zero denominator, compare against a multiple of the second series — differing
 * only in which series plays the second role, which sample floor it uses, which
 * multiple applies and what a breach is called. That cascade IS the safety
 * property, so it exists once (`evaluateEngagementComparison`) and the two
 * differences are data (`RATIO_SPEC`, `FLOOR_SPEC`), exactly as `gates.ts` does
 * for the two ceiling gates.
 *
 * PURE (plan D15): `now` is a parameter, nothing reads a clock, a database or
 * the environment, and every verdict carries the numbers that produced it
 * (plan D12).
 */

import type { DeliverabilityCell } from '@owlat/shared/deliverabilityRouting';
import {
	ENGAGEMENT_GATE_THRESHOLDS,
	resolveEngagementMetric,
	type EngagementMetric,
	type EngagementMetricOverrides,
} from './engagementConfig';
import { RAMP_STREAM_CONFIGS, type RampGateSampleFloors } from './gateConfig';
import { armEvidence, evidenceReason, insufficient, safeEngagementRate } from './gateEvidence';
import type { RampGateResult } from './gateTypes';
import { safeOutcomeCount } from '../../analytics/transportOutcomeSummary';
import type { TransportOutcomeSummary } from '../../analytics/transportOutcomeSummary';

export interface EngagementGateInput {
	/**
	 * The cell being gated, as ONE value. `stream` selects the ramp constants and
	 * `destinationProvider` selects the engagement metric, and carrying them
	 * separately would let a transactional config travel with a Gmail campaign
	 * cell and evaluate silently. The stream's `RampStreamConfig` is derived from
	 * it here rather than passed in, so there is nothing to keep consistent.
	 */
	readonly cell: DeliverabilityCell;
	/** Own-MTA arm outcomes for the concurrent window. */
	readonly own: TransportOutcomeSummary;
	/**
	 * Reference (relay/ESP) arm outcomes for the SAME window, or `null` when no
	 * reference transport is configured. `null` is a SUPPORTED CONFIGURATION
	 * (plan D2): the ratio simply holds, nothing fails and nothing is blocked.
	 * The standalone deployment's substitute lives in P1-7's evaluator.
	 */
	readonly reference: TransportOutcomeSummary | null;
	/**
	 * The RECENT own-arm window the slow-poison floor measures — `[now - 7d, now)`
	 * under the shipped weekly cadence, but the caller states its own window and
	 * this module never assumes one.
	 *
	 * Required rather than defaulted to `own`: an hourly controller that omitted
	 * it would silently compare one hour against thirty days under a check whose
	 * whole premise is a slow trend, and the result would look like a verdict.
	 */
	readonly ownRecent: TransportOutcomeSummary;
	/**
	 * The own arm's PRIOR 30-day window — `[now - 30d, now - 7d)`, DISJOINT from
	 * `ownRecent`. Absent (a young cell) means the floor cannot decide, never that
	 * it fails.
	 *
	 * The disjointness is the contract, not a detail. A trailing window that
	 * CONTAINS the recent one measures the decay against a baseline the decay has
	 * already dragged down, so the tripwire fires late and less often than its
	 * constant implies — the failure mode that gave this field its name.
	 */
	readonly ownPriorBaseline?: TransportOutcomeSummary | null;
	/** Per-evaluation metric substitutions; absent keys use the shipped table. */
	readonly metricOverrides?: EngagementMetricOverrides;
	readonly now: number;
}

/**
 * THE CALIBRATION READ SEAM. The only place this module touches a summary's
 * counters, so "does gate 4 read stratified traffic?" is a question about six
 * lines rather than about the whole file.
 */
function calibrationEngagement(
	summary: TransportOutcomeSummary,
	metric: EngagementMetric
): { readonly sample: number; readonly rate: number | null } {
	return {
		sample: safeOutcomeCount(summary.calibrationSent),
		rate: safeEngagementRate(
			metric === 'click' ? summary.calibrationClickRate : summary.calibrationOpenRate
		),
	};
}

/**
 * The four things that differ between the concurrent ratio and the slow-poison
 * floor. Everything else about them is one cascade.
 */
interface EngagementComparisonSpec {
	/** The window being judged. */
	readonly recentOf: (input: EngagementGateInput) => TransportOutcomeSummary;
	readonly recentFloorOf: (floors: RampGateSampleFloors) => number;
	/** The series it is judged against — a second transport, or the cell's past. */
	readonly referenceOf: (input: EngagementGateInput) => TransportOutcomeSummary | null;
	readonly referenceFloorOf: (floors: RampGateSampleFloors) => number;
	/**
	 * Which vocabulary a hold on the second series speaks. A hold reason names
	 * the thing to fix, and "the relay" and "this cell's own history" are not the
	 * same thing to fix.
	 */
	readonly referenceArm: 'reference' | 'baseline';
	/** The recent rate must be at least this multiple of the reference rate. */
	readonly ratioFloor: number;
	readonly failReason: 'reference_tolerance_breached' | 'absolute_threshold_breached';
}

/** Gate 4a — the concurrent ratio, own arm against the reference transport. */
const RATIO_SPEC: EngagementComparisonSpec = {
	recentOf: (input) => input.own,
	recentFloorOf: (floors) => floors.engagement,
	referenceOf: (input) => input.reference,
	referenceFloorOf: (floors) => floors.engagement,
	referenceArm: 'reference',
	ratioFloor: ENGAGEMENT_GATE_THRESHOLDS.minRatio,
	failReason: 'reference_tolerance_breached',
};

/**
 * Gate 4b — the slow-poison floor: the recent window against the cell's own
 * prior 30-day window.
 *
 * WHY THE BASELINE IS ALSO CALIBRATION-ONLY. The stratified cohort gets WORSE as
 * the share ramps (top percentile first, then everyone else), so a trailing
 * self-comparison over stratified traffic measures cohort drift and would fire
 * on a perfectly healthy ramp. The random slice is the only series that is
 * comparable against its own past.
 */
const FLOOR_SPEC: EngagementComparisonSpec = {
	recentOf: (input) => input.ownRecent,
	recentFloorOf: (floors) => floors.engagementRecent,
	referenceOf: (input) => input.ownPriorBaseline ?? null,
	referenceFloorOf: () => ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample,
	referenceArm: 'baseline',
	ratioFloor: ENGAGEMENT_GATE_THRESHOLDS.absoluteFloorRatio,
	failReason: 'absolute_threshold_breached',
};

/**
 * ORDERING, and why:
 *   1. Recent window absent/thin/stale/unmeasurable -> hold. We know nothing.
 *   2. Second series absent/thin/stale/unmeasurable -> hold. There is no ratio
 *      without a denominator, and plan D2 forbids an absent external account
 *      from producing anything worse than lower confidence.
 *   3. A second series at exactly zero -> hold, NOT pass. A zero denominator is
 *      a division by zero, and "0/0 looks fine" is precisely the bug that would
 *      let a dead cell ramp to 100%.
 *   4. Otherwise compare R against the floor. A recent window at zero against a
 *      healthy second series is R = 0, which FAILS — that is the signal this
 *      gate exists to catch.
 *
 * UNITS, because both numbers are small and neither is the other: the comparison
 * is made on the dimensionless RATIO (so the boundary is exact rather than the
 * nearest double to a product), and the measurement reports the multiple in
 * `ratioFloor` and the absolute rate it works out to in `thresholdRate`.
 */
function evaluateEngagementComparison(
	spec: EngagementComparisonSpec,
	input: EngagementGateInput
): RampGateResult {
	const { thresholds, sampleFloors } = RAMP_STREAM_CONFIGS[input.cell.stream];
	const metric = resolveEngagementMetric(input.cell.destinationProvider, input.metricOverrides);

	const recentSummary = spec.recentOf(input);
	const referenceSummary = spec.referenceOf(input);
	const minSample = spec.recentFloorOf(sampleFloors);
	const referenceMinSample = spec.referenceFloorOf(sampleFloors);

	const recent = calibrationEngagement(recentSummary, metric);
	const reference = referenceSummary ? calibrationEngagement(referenceSummary, metric) : null;

	/**
	 * `thresholdRate` is a MULTIPLE of the second series' rate, so it is only
	 * knowable once that rate has been accepted. Every hold therefore reports 0
	 * rather than a floor derived from evidence the gate has just refused to use —
	 * a number an operator would otherwise read off the dashboard as the live one.
	 */
	const holdShape = {
		thresholdRate: 0,
		ratioFloor: spec.ratioFloor,
		toleranceValuePp: null,
		ownSample: recent.sample,
		referenceSample: reference?.sample ?? null,
		minSample,
	} as const;

	const recentEvidence = armEvidence(
		recentSummary,
		recent.sample,
		minSample,
		input.now,
		thresholds
	);
	if (recentEvidence !== 'fresh' || recent.rate === null) {
		return insufficient('engagement_ratio', evidenceReason(recentEvidence, 'own'), {
			...holdShape,
			ownRate: recent.rate,
			referenceRate: reference?.rate ?? null,
		});
	}

	const referenceEvidence = armEvidence(
		referenceSummary,
		reference?.sample ?? 0,
		referenceMinSample,
		input.now,
		thresholds
	);
	// A rate of exactly zero reaches `evidenceReason('fresh', …)` alongside a
	// poisoned one, and correctly so: both mean "this series cannot act as a
	// denominator", which is a hold and never a pass.
	if (
		referenceEvidence !== 'fresh' ||
		!reference ||
		reference.rate === null ||
		reference.rate <= 0
	) {
		return insufficient('engagement_ratio', evidenceReason(referenceEvidence, spec.referenceArm), {
			...holdShape,
			ownRate: recent.rate,
			referenceRate: reference?.rate ?? null,
		});
	}

	const measurement = {
		...holdShape,
		thresholdRate: reference.rate * spec.ratioFloor,
		ownRate: recent.rate,
		referenceRate: reference.rate,
	} as const;

	return recent.rate / reference.rate >= spec.ratioFloor
		? {
				gate: 'engagement_ratio',
				status: 'pass',
				reason: 'within_threshold',
				measurement,
			}
		: {
				gate: 'engagement_ratio',
				status: 'fail',
				reason: spec.failReason,
				measurement,
			};
}

/** Gate 4a — the concurrent ratio between the two arms of the same send. */
export function evaluateEngagementRatioGate(input: EngagementGateInput): RampGateResult {
	return evaluateEngagementComparison(RATIO_SPEC, input);
}

/** Gate 4b — the slow-poison floor against the cell's own prior window. */
export function evaluateEngagementFloorGate(input: EngagementGateInput): RampGateResult {
	return evaluateEngagementComparison(FLOOR_SPEC, input);
}

/**
 * GATE 4, as the aggregator consumes it: one `RampGateResult` for the whole
 * engagement family.
 *
 * COMPOSITION, and why it is not a max-of-statuses fold. The ratio is the
 * measurement; the floor is a tripwire that only ever CONTRIBUTES A FAIL. A
 * holding floor — a young cell with no prior baseline, or a slice too thin to
 * compare against its own past — must never hold the ramp, or a fresh
 * deployment could never take its first step. So:
 *
 *   - the ratio fails      -> report the ratio (the anchor measurement);
 *   - the floor fails      -> report the floor (the slow poison the ratio missed);
 *   - anything else        -> report the ratio, including its holds.
 */
export function evaluateEngagementGate(input: EngagementGateInput): RampGateResult {
	const ratio = evaluateEngagementRatioGate(input);
	if (ratio.status === 'fail') return ratio;
	const floor = evaluateEngagementFloorGate(input);
	if (floor.status === 'fail') return floor;
	return ratio;
}
