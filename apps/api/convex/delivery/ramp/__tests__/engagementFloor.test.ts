/**
 * Gate 4b — THE SLOW POISON.
 *
 * Every concurrent gate compares the own arm against something measured at the
 * same time, so damage that accumulates SMOOTHLY — both arms drifting down
 * together, week after week, nothing ever breaching a threshold — passes all of
 * them. The weekly absolute-floor check compares this window against the cell's
 * OWN 30-day trailing engagement, and it is the only thing in the gate set that
 * can see that.
 *
 * It is also the check most likely to fire for the wrong reason (plan D14: a
 * redesigned newsletter looks exactly like a placement loss), so the suite pins
 * both halves: it fires on a LARGE smooth decay, and it stays quiet on a small
 * one and on a young cell with no baseline.
 */

import { describe, expect, it } from 'vitest';
import { ENGAGEMENT_GATE_THRESHOLDS } from '../engagementConfig';
import {
	evaluateEngagementFloorGate,
	evaluateEngagementGate,
	evaluateEngagementRatioGate,
} from '../engagementGate';
import { NOW, engagementArm, engagementInput } from './gateFixtures';

/** A window of `calibrationSent` calibration sends opening at `rate`. */
function engagementWindow(calibrationSent: number, rate: number, lastRecordedAt: number = NOW) {
	return engagementArm({
		sent: calibrationSent * 20,
		calibrationSent,
		calibrationOpened: Math.round(calibrationSent * rate),
		lastRecordedAt,
	});
}

const BASELINE_30D = engagementWindow(4_000, 0.1);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('gate 4b — weekly absolute floor', () => {
	it('fires on a smooth decay that every concurrent gate passes', () => {
		// Both arms decayed together, so the RATIO is a clean 1.0 …
		const decayed = engagementWindow(1_000, 0.06);
		const input = engagementInput({
			own: decayed,
			reference: engagementWindow(1_000, 0.06),
			ownTrailingBaseline: BASELINE_30D,
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
			ownTrailingBaseline: BASELINE_30D,
		});
		expect(evaluateEngagementFloorGate(input).status).toBe('pass');
		expect(evaluateEngagementGate(input).status).toBe('pass');
	});

	it('passes exactly AT the floor, and fails one send below it', () => {
		// 0.5 and 0.7 multiply EXACTLY in float64, so this really is the boundary
		// rather than a value that happens to sit near it.
		const baseline = engagementWindow(4_000, 0.5);
		const atFloor = 0.5 * ENGAGEMENT_GATE_THRESHOLDS.absoluteFloorRatio;
		expect(atFloor).toBe(0.35);

		const onTheLine = evaluateEngagementFloorGate(
			engagementInput({ own: engagementWindow(1_000, 0.35), ownTrailingBaseline: baseline })
		);
		expect(onTheLine.measurement.thresholdRate).toBe(0.35);
		expect(onTheLine.measurement.ownRate).toBe(0.35);
		expect(onTheLine.status).toBe('pass');

		const oneBelow = evaluateEngagementFloorGate(
			engagementInput({ own: engagementWindow(1_000, 0.349), ownTrailingBaseline: baseline })
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
			ownTrailingBaseline: engagementWindow(ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample - 1, 0.1),
		});
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.status).toBe('insufficient_data');
		expect(floor.reason).toBe('reference_sample_below_floor');
	});

	it('decides at exactly the baseline minimum sample', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0.01),
			ownTrailingBaseline: engagementWindow(ENGAGEMENT_GATE_THRESHOLDS.baselineMinSample, 0.1),
		});
		expect(evaluateEngagementFloorGate(input).status).toBe('fail');
	});

	it('HOLDS on a stale baseline rather than trusting three-week-old evidence', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0.01),
			ownTrailingBaseline: engagementWindow(4_000, 0.1, NOW - 21 * DAY_MS),
		});
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.status).toBe('insufficient_data');
		expect(floor.reason).toBe('reference_evidence_stale');
	});

	it('HOLDS on a thin recent window — the floor obeys the same sample rule (D10)', () => {
		const input = engagementInput({
			own: engagementWindow(399, 0.01),
			ownTrailingBaseline: BASELINE_30D,
		});
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.status).toBe('insufficient_data');
		expect(floor.reason).toBe('own_sample_below_floor');
	});

	it('HOLDS when the baseline itself engaged at zero — there is nothing to decay from', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0),
			ownTrailingBaseline: engagementWindow(4_000, 0),
		});
		const floor = evaluateEngagementFloorGate(input);
		expect(floor.status).toBe('insufficient_data');
		expect(floor.reason).toBe('reference_rate_unmeasurable');
	});

	it('compares the explicit weekly window when one is supplied', () => {
		const input = engagementInput({
			// The evaluation window is healthy …
			own: engagementWindow(1_000, 0.1),
			// … but the last SEVEN DAYS have collapsed.
			ownWeekly: engagementWindow(1_000, 0.02),
			ownTrailingBaseline: BASELINE_30D,
		});
		expect(evaluateEngagementFloorGate(input).status).toBe('fail');
	});

	it('applies the metric substitution to the floor too — apple decays on clicks', () => {
		const own = engagementArm({
			sent: 20_000,
			calibrationSent: 1_000,
			calibrationOpened: 500, // opens look great …
			calibrationClicked: 20, // … clicks have collapsed
		});
		const baseline = engagementArm({
			sent: 80_000,
			calibrationSent: 4_000,
			calibrationOpened: 400,
			calibrationClicked: 400, // 10% baseline click rate
		});
		const apple = evaluateEngagementFloorGate(
			engagementInput({ own, ownTrailingBaseline: baseline, destinationProvider: 'apple' })
		);
		expect(apple.status).toBe('fail');
		expect(apple.measurement.ownRate).toBeCloseTo(0.02, 10);

		const gmail = evaluateEngagementFloorGate(
			engagementInput({ own, ownTrailingBaseline: baseline, destinationProvider: 'gmail' })
		);
		expect(gmail.status).toBe('pass');
	});

	it('reads the CALIBRATION slice, not stratified traffic, on both sides', () => {
		const own = engagementArm({
			sent: 20_000,
			opened: 200, // stratified collapse …
			calibrationSent: 1_000,
			calibrationOpened: 100, // … slice healthy against the baseline
		});
		const input = engagementInput({ own, ownTrailingBaseline: BASELINE_30D });
		expect(evaluateEngagementFloorGate(input).status).toBe('pass');
	});

	it('is pure — the same input evaluates identically twice', () => {
		const input = engagementInput({
			own: engagementWindow(1_000, 0.06),
			ownTrailingBaseline: BASELINE_30D,
		});
		expect(evaluateEngagementFloorGate(input)).toStrictEqual(evaluateEngagementFloorGate(input));
	});
});
