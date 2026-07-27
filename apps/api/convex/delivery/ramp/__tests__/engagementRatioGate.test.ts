/**
 * Gate 4 — THE RATIO MATRIX.
 *
 * R = calibration engagement(own) / calibration engagement(reference), against
 * a 0.95 floor. The cases below are the ones where a plausible implementation
 * gets it wrong: the exact boundary, an own arm at zero (a real failure) and a
 * reference arm at zero (a division by zero that must NOT read as a pass).
 */

import { describe, expect, it } from 'vitest';
import { ENGAGEMENT_GATE_THRESHOLDS } from '../engagementConfig';
import { evaluateEngagementRatioGate } from '../engagementGate';
import { engagementArm, engagementInput } from './gateFixtures';

/** 1000 calibration sends with `opened` of them opened. */
function slice(opened: number) {
	return engagementArm({ sent: 20_000, calibrationSent: 1000, calibrationOpened: opened });
}

function verdict(ownOpened: number, referenceOpened: number) {
	return evaluateEngagementRatioGate(
		engagementInput({ own: slice(ownOpened), reference: slice(referenceOpened) })
	);
}

describe('gate 4 — engagement ratio matrix', () => {
	it('passes when the arms engage identically', () => {
		const result = verdict(200, 200);
		expect(result.gate).toBe('engagement_ratio');
		expect(result.status).toBe('pass');
		expect(result.reason).toBe('within_threshold');
		expect(result.measurement.ownRate).toBeCloseTo(0.2, 10);
		expect(result.measurement.referenceRate).toBeCloseTo(0.2, 10);
	});

	it('passes at the exact 0.95 boundary', () => {
		const result = verdict(190, 200);
		expect(result.status).toBe('pass');
		// The boundary is inclusive by construction: R === minRatio.
		const { ownRate, referenceRate } = result.measurement;
		expect(ownRate).toBeCloseTo(0.19, 10);
		expect(referenceRate).toBeCloseTo(0.2, 10);
		expect((ownRate ?? 0) / (referenceRate ?? 1)).toBe(ENGAGEMENT_GATE_THRESHOLDS.minRatio);
	});

	it('passes just above the boundary', () => {
		expect(verdict(191, 200).status).toBe('pass');
	});

	it('fails just below the boundary', () => {
		const result = verdict(189, 200);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('reference_tolerance_breached');
	});

	it('fails hard when the own arm engages far worse', () => {
		expect(verdict(100, 200).status).toBe('fail');
	});

	it('passes when the own arm engages BETTER than the reference arm', () => {
		expect(verdict(260, 200).status).toBe('pass');
	});

	it('fails when the own arm is at zero against a healthy reference arm', () => {
		const result = verdict(0, 200);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('reference_tolerance_breached');
		expect(result.measurement.ownRate).toBe(0);
	});

	it('HOLDS when the reference arm is at zero — a zero denominator is not a pass', () => {
		const result = verdict(200, 0);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('reference_rate_unmeasurable');
	});

	it('HOLDS when both arms are at zero', () => {
		const result = verdict(0, 0);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('reference_rate_unmeasurable');
	});

	it('HOLDS when there is no reference transport at all (plan D2)', () => {
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: slice(200), reference: null })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('evidence_absent');
	});

	it('carries the threshold and both samples with every verdict (plan D12)', () => {
		const result = verdict(100, 200);
		expect(result.measurement.thresholdRate).toBe(ENGAGEMENT_GATE_THRESHOLDS.minRatio);
		expect(result.measurement.toleranceValuePp).toBeNull();
		expect(result.measurement.ownSample).toBe(1000);
		expect(result.measurement.referenceSample).toBe(1000);
		expect(result.measurement.minSample).toBe(400);
	});

	it('is pure — the same input evaluates identically twice', () => {
		expect(verdict(189, 200)).toStrictEqual(verdict(189, 200));
	});
});
