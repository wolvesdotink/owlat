/**
 * Gate 4 — THE CALIBRATION RESTRICTION (plan D8). THE KEY SUITE.
 *
 * Assignment is stratified by default: the own arm gets the top engagement
 * percentile first, because that is what warms an IP. So the GENERAL counters
 * flatter the own arm no matter what the transport did, and a gate that reads
 * them looks correct in every other suite while systematically over-reporting
 * the own arm — the exact failure this file exists to catch.
 *
 * The fixtures below are built so the two stories DISAGREE: stratified traffic
 * says the own arm is winning by 5x, the random calibration slice says it is
 * losing by half. The gate must believe the slice.
 */

import { describe, expect, it } from 'vitest';
import { evaluateEngagementGate, evaluateEngagementRatioGate } from '../engagementGate';
import { engagementArm, engagementInput } from './gateFixtures';

/** Stratified: 50% opens. Calibration slice: 10% opens. */
const OWN_FLATTERED_BY_STRATIFICATION = engagementArm({
	sent: 10_000,
	opened: 5_000,
	clicked: 2_000,
	calibrationSent: 1_000,
	calibrationOpened: 100,
	calibrationClicked: 40,
});

/** Stratified: 10% opens. Calibration slice: 20% opens. */
const REFERENCE_UNDERSOLD_BY_STRATIFICATION = engagementArm({
	sent: 10_000,
	opened: 1_000,
	clicked: 400,
	calibrationSent: 1_000,
	calibrationOpened: 200,
	calibrationClicked: 80,
});

const INPUT = engagementInput({
	own: OWN_FLATTERED_BY_STRATIFICATION,
	reference: REFERENCE_UNDERSOLD_BY_STRATIFICATION,
});

describe('gate 4 — calibration slice only', () => {
	it('the fixture really does tell two opposite stories', () => {
		expect(OWN_FLATTERED_BY_STRATIFICATION.openRate).toBeCloseTo(0.5, 10);
		expect(REFERENCE_UNDERSOLD_BY_STRATIFICATION.openRate).toBeCloseTo(0.1, 10);
		expect(OWN_FLATTERED_BY_STRATIFICATION.calibrationOpenRate).toBeCloseTo(0.1, 10);
		expect(REFERENCE_UNDERSOLD_BY_STRATIFICATION.calibrationOpenRate).toBeCloseTo(0.2, 10);
	});

	it('FAILS the cell whose stratified numbers look great and whose slice is bad', () => {
		const result = evaluateEngagementRatioGate(INPUT);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('reference_tolerance_breached');
	});

	it('reports the CALIBRATION rates in the measurement, never the general ones', () => {
		const { ownRate, referenceRate } = evaluateEngagementRatioGate(INPUT).measurement;
		expect(ownRate).toBeCloseTo(0.1, 10);
		expect(referenceRate).toBeCloseTo(0.2, 10);
		expect(ownRate).not.toBeCloseTo(0.5, 3);
	});

	it('denominates the sample on calibrationSent, not on sent', () => {
		const { ownSample, referenceSample } = evaluateEngagementRatioGate(INPUT).measurement;
		expect(ownSample).toBe(1_000);
		expect(referenceSample).toBe(1_000);
	});

	it('is INDIFFERENT to the general counters — moving them changes nothing', () => {
		const baseline = evaluateEngagementRatioGate(INPUT);
		const generalCountersInverted = evaluateEngagementRatioGate(
			engagementInput({
				own: engagementArm({
					sent: 10_000,
					opened: 100,
					clicked: 10,
					calibrationSent: 1_000,
					calibrationOpened: 100,
					calibrationClicked: 40,
				}),
				reference: engagementArm({
					sent: 10_000,
					opened: 9_000,
					clicked: 5_000,
					calibrationSent: 1_000,
					calibrationOpened: 200,
					calibrationClicked: 80,
				}),
			})
		);
		expect(generalCountersInverted).toStrictEqual(baseline);
	});

	it('holds the same restriction through the composed gate 4', () => {
		expect(evaluateEngagementGate(INPUT).status).toBe('fail');
	});

	it('a cell whose slice is healthy PASSES even when its stratified numbers are poor', () => {
		const result = evaluateEngagementRatioGate(
			engagementInput({
				own: engagementArm({
					sent: 10_000,
					opened: 200,
					calibrationSent: 1_000,
					calibrationOpened: 200,
				}),
				reference: engagementArm({
					sent: 10_000,
					opened: 8_000,
					calibrationSent: 1_000,
					calibrationOpened: 200,
				}),
			})
		);
		expect(result.status).toBe('pass');
	});
});
