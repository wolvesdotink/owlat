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
 * nothing ever breaching a threshold — passes all of them. The weekly
 * absolute-floor check is the only defence against that: this window's
 * engagement against the cell's OWN 30-day trailing engagement. It lives in
 * this module because it shares the metric substitution and the calibration
 * restriction, and it only ever contributes a FAIL (see
 * `evaluateEngagementGate`), so a young cell with no baseline can never be held
 * back by it.
 *
 * PURE (plan D15): `now` is a parameter, nothing reads a clock, a database or
 * the environment, and every verdict carries the numbers that produced it
 * (plan D12).
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import {
	ENGAGEMENT_GATE_THRESHOLDS,
	resolveEngagementMetric,
	type EngagementGateThresholds,
	type EngagementMetric,
	type EngagementMetricOverrides,
} from './engagementConfig';
import type { RampStreamConfig } from './gateConfig';
import { armEvidence, evidenceReason, insufficient, safeRate } from './gateEvidence';
import type { RampGateResult } from './gateTypes';
import { safeOutcomeCount } from '../../analytics/transportOutcomeSummary';
import type { TransportOutcomeSummary } from '../../analytics/transportOutcomeSummary';

export interface EngagementGateInput {
	/** The cell's mailbox provider — it selects the metric (MPP handling). */
	readonly destinationProvider: DestinationProviderKey;
	/** Sample floors, freshness allowances and the stream's ramp constants. */
	readonly config: RampStreamConfig;
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
	 * The own arm's trailing 30-day window, for the slow-poison floor. Absent
	 * (a young cell) means the floor cannot decide — never that it fails.
	 */
	readonly ownTrailingBaseline?: TransportOutcomeSummary | null;
	/**
	 * The own arm's last-7-day window, which the floor compares against the
	 * baseline. Defaults to `own` when the caller evaluates on a weekly cadence
	 * and the two are the same window.
	 */
	readonly ownWeekly?: TransportOutcomeSummary | null;
	/** Per-evaluation metric substitutions; absent keys use the shipped table. */
	readonly metricOverrides?: EngagementMetricOverrides;
	/** Threshold overrides — supplied by tests and by nothing else today. */
	readonly thresholds?: EngagementGateThresholds;
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
		rate: safeRate(metric === 'click' ? summary.calibrationClickRate : summary.calibrationOpenRate),
	};
}

/**
 * Gate 4a — the concurrent ratio.
 *
 * ORDERING, and why:
 *   1. Own arm absent/thin/stale/unmeasurable -> hold. We know nothing.
 *   2. Reference arm absent/thin/stale/unmeasurable -> hold. There is no ratio
 *      without a denominator, and plan D2 forbids an absent external account
 *      from producing anything worse than lower confidence.
 *   3. Reference engagement of exactly zero -> hold, NOT pass. A zero
 *      denominator is a division by zero, and "0/0 looks fine" is precisely the
 *      bug that would let a dead cell ramp to 100%.
 *   4. Otherwise compare R against the ratio floor. An own arm at zero against
 *      a healthy reference is R = 0, which FAILS — that is the signal this gate
 *      exists to catch.
 */
export function evaluateEngagementRatioGate(input: EngagementGateInput): RampGateResult {
	const thresholds = input.config.thresholds;
	const engagementThresholds = input.thresholds ?? ENGAGEMENT_GATE_THRESHOLDS;
	const minSample = input.config.sampleFloors.engagement;
	const metric = resolveEngagementMetric(input.destinationProvider, input.metricOverrides);

	const own = calibrationEngagement(input.own, metric);
	const reference = input.reference ? calibrationEngagement(input.reference, metric) : null;

	const shape = {
		thresholdRate: engagementThresholds.minRatio,
		toleranceValuePp: null,
		ownSample: own.sample,
		referenceSample: reference?.sample ?? null,
		minSample,
	} as const;

	const ownEvidence = armEvidence(input.own, own.sample, minSample, input.now, thresholds);
	if (ownEvidence !== 'fresh' || own.rate === null) {
		return insufficient('engagement_ratio', evidenceReason(ownEvidence, 'own'), {
			...shape,
			ownRate: own.rate,
			referenceRate: reference?.rate ?? null,
		});
	}

	const referenceEvidence = armEvidence(
		input.reference,
		reference?.sample ?? 0,
		minSample,
		input.now,
		thresholds
	);
	if (referenceEvidence !== 'fresh' || !reference || reference.rate === null) {
		return insufficient('engagement_ratio', evidenceReason(referenceEvidence, 'reference'), {
			...shape,
			ownRate: own.rate,
			referenceRate: reference?.rate ?? null,
		});
	}

	const measurement = { ...shape, ownRate: own.rate, referenceRate: reference.rate } as const;

	// No denominator, no ratio. Both arms at zero lands here too, which is the
	// correct answer for it: two dead arms are unmeasured, not comparable.
	if (reference.rate <= 0) {
		return insufficient('engagement_ratio', 'reference_rate_unmeasurable', measurement);
	}

	return own.rate / reference.rate >= engagementThresholds.minRatio
		? {
				gate: 'engagement_ratio',
				status: 'pass',
				reason: 'within_threshold',
				measurement,
			}
		: {
				gate: 'engagement_ratio',
				status: 'fail',
				reason: 'reference_tolerance_breached',
				measurement,
			};
}

/**
 * Gate 4b — THE SLOW-POISON FLOOR: this window's calibration engagement against
 * the cell's own 30-day trailing calibration engagement.
 *
 * WHY THE BASELINE IS THE "REFERENCE" ARM in the measurement. This check is
 * one-armed in transport terms but two-armed in shape: the cell's own past
 * plays the role the relay plays in gate 4a, so it reuses `referenceRate` /
 * `referenceSample` and the `reference_*` hold reasons rather than inventing a
 * parallel vocabulary the dashboard would have to learn. P1-7's trailing-
 * baseline evaluator makes exactly the same substitution for the whole gate set.
 *
 * WHY THE BASELINE IS ALSO CALIBRATION-ONLY. The stratified cohort gets WORSE as
 * the share ramps (top percentile first, then everyone else), so a trailing
 * self-comparison over stratified traffic measures cohort drift and would fire
 * on a perfectly healthy ramp. The random slice is the only series that is
 * comparable against its own past.
 */
export function evaluateEngagementFloorGate(input: EngagementGateInput): RampGateResult {
	const thresholds = input.config.thresholds;
	const engagementThresholds = input.thresholds ?? ENGAGEMENT_GATE_THRESHOLDS;
	const minSample = input.config.sampleFloors.engagement;
	const metric = resolveEngagementMetric(input.destinationProvider, input.metricOverrides);

	const recentSummary = input.ownWeekly ?? input.own;
	const baselineSummary = input.ownTrailingBaseline ?? null;
	const recent = calibrationEngagement(recentSummary, metric);
	const baseline = baselineSummary ? calibrationEngagement(baselineSummary, metric) : null;
	const baselineRate = baseline?.rate ?? null;
	const baselineFloorSample = engagementThresholds.baselineMinSample;

	const shape = {
		// The threshold is only knowable once the baseline is: until then there is
		// no absolute rate to report, and reporting 0 would read as "floor of 0%".
		thresholdRate:
			baselineRate === null ? 0 : baselineRate * engagementThresholds.absoluteFloorRatio,
		toleranceValuePp: null,
		ownSample: recent.sample,
		referenceSample: baseline?.sample ?? null,
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
			...shape,
			ownRate: recent.rate,
			referenceRate: baselineRate,
		});
	}

	const baselineEvidence = armEvidence(
		baselineSummary,
		baseline?.sample ?? 0,
		baselineFloorSample,
		input.now,
		thresholds
	);
	if (baselineEvidence !== 'fresh' || !baseline || baseline.rate === null || baseline.rate <= 0) {
		return insufficient('engagement_ratio', evidenceReason(baselineEvidence, 'reference'), {
			...shape,
			ownRate: recent.rate,
			referenceRate: baselineRate,
		});
	}

	const measurement = {
		...shape,
		thresholdRate: baseline.rate * engagementThresholds.absoluteFloorRatio,
		ownRate: recent.rate,
		referenceRate: baseline.rate,
	} as const;

	return recent.rate >= measurement.thresholdRate
		? {
				gate: 'engagement_ratio',
				status: 'pass',
				reason: 'within_threshold',
				measurement,
			}
		: {
				gate: 'engagement_ratio',
				status: 'fail',
				reason: 'absolute_threshold_breached',
				measurement,
			};
}

/**
 * GATE 4, as the aggregator consumes it: one `RampGateResult` for the whole
 * engagement family.
 *
 * COMPOSITION, and why it is not a max-of-statuses fold. The ratio is the
 * measurement; the floor is a tripwire that only ever CONTRIBUTES A FAIL. A
 * holding floor — a young cell with no 30-day baseline, or a slice too thin to
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
