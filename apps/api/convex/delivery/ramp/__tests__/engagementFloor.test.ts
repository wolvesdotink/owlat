/**
 * Gate 4b — THE SLOW POISON.
 *
 * Every concurrent gate compares the own arm against something measured at the
 * same time, so damage that accumulates SMOOTHLY — both arms drifting down
 * together, week after week, nothing ever breaching a threshold — passes all of
 * them. The absolute-floor check compares the cell's RECENT window against its
 * OWN PRIOR 30-day window, and it is the only thing in the gate set that can see
 * that.
 *
 * It is also the check most likely to fire for the wrong reason (plan D14: a
 * redesigned newsletter looks exactly like a placement loss), so the suite pins
 * both halves: it fires on a LARGE smooth decay, and it stays quiet on a small
 * one and on a young cell with no baseline.
 *
 * AND THE WINDOW CONTRACT. `ownPriorBaseline` must EXCLUDE the recent window.
 * The overlapping-baseline case below is the reason: an overlapping baseline is
 * dragged down by the very decay it is supposed to reveal, so the same decay
 * that trips the tripwire against a prior window passes against a trailing one.
 *
 * AND ITS AGE, which is the other half of that contract and the half that is
 * easy to fake. A window `[now - 30d, now - 7d)` has a NEWEST observation at
 * most a week old and, if the cell went quiet, up to thirty days old. Every
 * baseline in this suite is therefore dated at `BASELINE_AGE`, not at `NOW`: a
 * baseline dated `NOW` is impossible at runtime, and a suite built out of them
 * would pin its headline claim against a branch production never takes. That is
 * exactly how the concurrent 48h freshness rule came to be applied to a series
 * that is a week old by construction — which made this whole gate return
 * `insufficient_data` on every real input while the suite stayed green.
 */

import { describe, expect, it } from 'vitest';
import { ENGAGEMENT_GATE_THRESHOLDS } from '../engagementConfig';
import { RAMP_GATE_SAMPLE_FLOORS, RAMP_GATE_THRESHOLDS } from '../gateConfig';
import {
	evaluateEngagementFloorGate,
	evaluateEngagementGate,
	evaluateEngagementRatioGate,
} from '../engagementGate';
import { NOW, arm, engagementCell, engagementInput } from './gateFixtures';

/** A window of `calibrationSent` calibration sends opening at `rate`. */
function engagementWindow(calibrationSent: number, rate: number, lastRecordedAt: number = NOW) {
	return arm({
		sent: calibrationSent * 20,
		calibrationSent,
		calibrationOpened: Math.round(calibrationSent * rate),
		lastRecordedAt,
	});
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The age a prior-window summary actually carries: its window ENDS at
 * `now - 7d`, so its newest bucket is a week old. Anything younger than this is
 * not a prior baseline.
 */
const BASELINE_AGE = NOW - 7 * DAY_MS;

const BASELINE_30D = engagementWindow(4_000, 0.1, BASELINE_AGE);

describe("gate 4b — the absolute floor against the cell's own past", () => {
	it('fires on a smooth decay that every concurrent gate passes', () => {
		// Both arms decayed together, so the RATIO is a clean 1.0 …
		const decayed = engagementWindow(1_000, 0.06);
		const input = engagementInput({
			own: decayed,
			reference: engagementWindow(1_000, 0.06),
			ownPriorBaseline: BASELINE_30D,
		});
		expect(evaluateEngagementRatioGate(input).status).toBe('pass');

		// … and yet the cell has lost 40% of its own engagement.
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.gate).toBe('engagement_ratio');
		expect(floor.status).toBe('fail');
		expect(floor.reason).toBe('absolute_threshold_breached');
		expect(floor.measurement.ownRate).toBeCloseTo(0.06, 10);
		expect(floor.measurement.referenceRate).toBeCloseTo(0.1, 10);
		expect(floor.measurement.thresholdRate).toBeCloseTo(0.07, 10);

		// The composed gate 4 reports the failure the ratio could not see.
		expect(evaluateEngagementGate(input).status).toBe('fail');
	});

	it('stays quiet on a small decline (plan D14: editorial moves are not placement losses)', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0.08),
			reference: engagementWindow(1_000, 0.08),
			ownPriorBaseline: BASELINE_30D,
		});
		expect(evaluateEngagementFloorGate(input).status).toBe('pass');
		expect(evaluateEngagementGate(input).status).toBe('pass');
	});

	it('passes exactly AT the floor, and fails one send below it', () => {
		// 0.5 and 0.7 multiply EXACTLY in float64, so this really is the boundary
		// rather than a value that happens to sit near it.
		const baseline = engagementWindow(4_000, 0.5, BASELINE_AGE);
		const atFloor = 0.5 * ENGAGEMENT_GATE_THRESHOLDS.absoluteFloorRatio;
		expect(atFloor).toBe(0.35);

		const onTheLine = evaluateEngagementFloorGate(
			engagementInput({ own: engagementWindow(1_000, 0.35), ownPriorBaseline: baseline })
		);
		expect(onTheLine.measurement.thresholdRate).toBe(0.35);
		expect(onTheLine.measurement.ownRate).toBe(0.35);
		expect(onTheLine.status).toBe('pass');
		// A PASS carries both floors as well, each against the sample it governs.
		expect(onTheLine.measurement.minSample).toBe(RAMP_GATE_SAMPLE_FLOORS.engagementRecent);
		expect(onTheLine.measurement.referenceMinSample).toBe(
			ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample
		);

		const oneBelow = evaluateEngagementFloorGate(
			engagementInput({ own: engagementWindow(1_000, 0.349), ownPriorBaseline: baseline })
		);
		expect(oneBelow.status).toBe('fail');
	});

	it('HOLDS — never fails — when the cell has no 30-day baseline yet', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0.01),
			reference: engagementWindow(1_000, 0.01),
		});
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.status).toBe('insufficient_data');
		expect(floor.reason).toBe('evidence_absent');
		// A young cell must still be able to take its first step.
		expect(evaluateEngagementGate(input).status).toBe('pass');
	});

	it('HOLDS on a baseline below its own minimum sample', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0.01),
			ownPriorBaseline: engagementWindow(
				ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample - 1,
				0.1,
				BASELINE_AGE
			),
		});
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.status).toBe('insufficient_data');
		expect(floor.reason).toBe('baseline_sample_below_floor');
		// The audit row (plan D12) must report BOTH floors, each beside the sample
		// it governs. The two differ by 3x here, so a measurement carrying only one
		// of them would tell an operator something false about the other arm —
		// either that a 1,000-send recent window is below a 1,200 floor, or that a
		// 1,199-send baseline is above a 400 one.
		expect(floor.measurement.minSample).toBe(RAMP_GATE_SAMPLE_FLOORS.engagementRecent);
		expect(floor.measurement.referenceMinSample).toBe(ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample);
		expect(floor.measurement.minSample).not.toBe(floor.measurement.referenceMinSample);
		expect(floor.measurement.ownSample).toBe(1_000);
		expect(floor.measurement.referenceSample).toBe(
			ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample - 1
		);
	});

	it('decides at exactly the baseline minimum sample', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0.01),
			ownPriorBaseline: engagementWindow(
				ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample,
				0.1,
				BASELINE_AGE
			),
		});
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.status).toBe('fail');
		// A DECIDED verdict reports both governing floors too — the baseline's is
		// what a reader needs to judge how much the comparison is worth, and it is
		// invisible in `reason` on a pass or a fail.
		expect(floor.measurement.minSample).toBe(RAMP_GATE_SAMPLE_FLOORS.engagementRecent);
		expect(floor.measurement.referenceMinSample).toBe(ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample);
	});

	it('accepts a baseline aged as its window contract requires, and one at the allowance', () => {
		// A week old — the youngest a prior window can be — decides.
		expect(
			evaluateEngagementFloorGate(
				engagementInput({ own: engagementWindow(1_000, 0.06), ownPriorBaseline: BASELINE_30D })
			).status
		).toBe('fail');

		// Thirty days old — a cell that went quiet at the START of its prior window —
		// still decides, because the allowance covers the whole contracted window.
		const wentQuiet = engagementWindow(4_000, 0.1, NOW - 30 * DAY_MS);
		expect(NOW - 30 * DAY_MS).toBeGreaterThan(NOW - RAMP_GATE_THRESHOLDS.maxBaselineAgeMs);
		expect(
			evaluateEngagementFloorGate(
				engagementInput({ own: engagementWindow(1_000, 0.06), ownPriorBaseline: wentQuiet })
			).status
		).toBe('fail');
	});

	it('HOLDS on a baseline older than its own allowance — not on the concurrent 48h rule', () => {
		// 48h is the CONCURRENT rule; a prior window is a week old by contract, so
		// judging it by that rule would hold on every real input and delete the gate.
		const aWeekOld = engagementWindow(4_000, 0.1, BASELINE_AGE);
		expect(NOW - BASELINE_AGE).toBeGreaterThan(RAMP_GATE_THRESHOLDS.maxEvidenceAgeMs);
		expect(
			evaluateEngagementFloorGate(
				engagementInput({ own: engagementWindow(1_000, 0.06), ownPriorBaseline: aWeekOld })
			).status
		).toBe('fail');

		// Past the baseline allowance it is genuinely stale.
		const tooOld = engagementWindow(
			4_000,
			0.1,
			NOW - RAMP_GATE_THRESHOLDS.maxBaselineAgeMs - DAY_MS
		);
		const floor = evaluateEngagementFloorGate(
			engagementInput({ own: engagementWindow(1_000, 0.01), ownPriorBaseline: tooOld })
		);
		expect(floor.status).toBe('insufficient_data');
		expect(floor.reason).toBe('baseline_evidence_stale');
	});

	it("does NOT widen the concurrent ratio's freshness rule", () => {
		// Gate 4a's reference arm is the other half of the same send: a week-old
		// reference is stale there, and the baseline's allowance must not leak.
		const ratio = evaluateEngagementRatioGate(
			engagementInput({
				own: engagementWindow(1_000, 0.1),
				reference: engagementWindow(1_000, 0.1, BASELINE_AGE),
			})
		);
		expect(ratio.status).toBe('insufficient_data');
		expect(ratio.reason).toBe('reference_evidence_stale');
	});

	it('HOLDS on a thin recent window — the floor obeys the same sample rule (D10)', () => {
		const input = engagementInput({
			own: engagementWindow(399, 0.01),
			ownPriorBaseline: BASELINE_30D,
		});
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.status).toBe('insufficient_data');
		expect(floor.reason).toBe('own_sample_below_floor');
	});

	it('HOLDS when the baseline itself engaged at zero — there is nothing to decay from', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0),
			ownPriorBaseline: engagementWindow(4_000, 0, BASELINE_AGE),
		});
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.status).toBe('insufficient_data');
		expect(floor.reason).toBe('baseline_rate_unmeasurable');
	});

	it('compares the explicit RECENT window, not the evaluation window', () => {
		const input = engagementInput({
			// The evaluation window is healthy …
			own: engagementWindow(1_000, 0.1),
			// … but the recent window has collapsed.
			ownRecent: engagementWindow(1_000, 0.02),
			ownPriorBaseline: BASELINE_30D,
		});
		expect(evaluateEngagementFloorGate(input).status).toBe('fail');
	});

	it('an OVERLAPPING baseline damps the decay it is supposed to reveal', () => {
		// 23 prior days at 10%, then 7 recent days at ~6.8% — a real decay just past
		// the 0.7 floor.
		const prior = arm({
			sent: 92_000,
			calibrationSent: 4_600,
			calibrationOpened: 460,
			lastRecordedAt: BASELINE_AGE,
		});
		const recent = arm({ sent: 28_000, calibrationSent: 1_400, calibrationOpened: 95 });
		expect(prior.calibrationOpenRate).toBeCloseTo(0.1, 10);

		const againstPrior = evaluateEngagementFloorGate(
			engagementInput({ own: recent, ownRecent: recent, ownPriorBaseline: prior })
		);
		expect(againstPrior.status).toBe('fail');

		// The SAME 30 days, summed as one trailing window that contains the decayed
		// week: the baseline has been dragged down with the cell, the floor drops
		// with it, and the tripwire stays silent. That is why the field is the PRIOR
		// window and why its disjointness is a contract rather than a detail.
		const trailingIncludingRecent = arm({
			sent: 120_000,
			calibrationSent: 6_000,
			calibrationOpened: 555,
			lastRecordedAt: BASELINE_AGE,
		});
		const againstTrailing = evaluateEngagementFloorGate(
			engagementInput({
				own: recent,
				ownRecent: recent,
				ownPriorBaseline: trailingIncludingRecent,
			})
		);
		expect(againstTrailing.status).toBe('pass');
		expect(againstTrailing.measurement.thresholdRate).toBeLessThan(
			againstPrior.measurement.thresholdRate
		);
	});

	it('applies the metric substitution to the floor too — apple decays on clicks', () => {
		const own = arm({
			sent: 20_000,
			calibrationSent: 1_000,
			calibrationOpened: 500, // opens look great …
			calibrationClicked: 20, // … clicks have collapsed
		});
		const baseline = arm({
			sent: 80_000,
			calibrationSent: 4_000,
			calibrationOpened: 400,
			calibrationClicked: 400, // 10% baseline click rate
			lastRecordedAt: BASELINE_AGE,
		});
		const apple = evaluateEngagementFloorGate(
			engagementInput({ own, ownPriorBaseline: baseline, cell: engagementCell('apple') })
		);
		expect(apple.status).toBe('fail');
		expect(apple.measurement.ownRate).toBeCloseTo(0.02, 10);

		const gmail = evaluateEngagementFloorGate(
			engagementInput({ own, ownPriorBaseline: baseline, cell: engagementCell('gmail') })
		);
		expect(gmail.status).toBe('pass');
	});

	it('reads the CALIBRATION slice, not stratified traffic, on both sides', () => {
		const own = arm({
			sent: 20_000,
			opened: 200, // stratified collapse …
			calibrationSent: 1_000,
			calibrationOpened: 100, // … slice healthy against the baseline
		});
		const input = engagementInput({ own, ownPriorBaseline: BASELINE_30D });
		expect(evaluateEngagementFloorGate(input).status).toBe('pass');
	});

	it('is pure — the same input evaluates identically twice', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0.06),
			ownPriorBaseline: BASELINE_30D,
		});
		expect(evaluateEngagementFloorGate(input)).toStrictEqual(evaluateEngagementFloorGate(input));
	});
});
