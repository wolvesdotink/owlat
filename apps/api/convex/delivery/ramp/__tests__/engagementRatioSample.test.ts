/**
 * Gate 4 — THE MINIMUM SAMPLE IS ENFORCED, NOT ADVISORY (plan D10).
 *
 * Below the floor the gate must return `insufficient_data` so the controller
 * HOLDS: it never increases on thin data and never decreases on it either. The
 * floor is checked PER ARM and it is the CALIBRATION sample that counts — a
 * cell with 50,000 stratified sends and 12 calibration sends has not measured
 * anything.
 */

import { expect, it } from 'vitest';
import { RAMP_GATE_SAMPLE_FLOORS } from '../gateConfig';
import { evaluateEngagementRatioGate } from '../engagementGate';
import { arm, describeEquipped, engagementInput } from './gateFixtures';

const FLOOR = RAMP_GATE_SAMPLE_FLOORS.engagement;

/** A slice of `calibrationSent` sends engaging at 20%. */
function slice(calibrationSent: number) {
	return arm({
		sent: 50_000,
		opened: 25_000,
		calibrationSent,
		calibrationOpened: Math.round(calibrationSent * 0.2),
	});
}

function verdict(ownSample: number, referenceSample: number) {
	return evaluateEngagementRatioGate(
		engagementInput({ own: slice(ownSample), reference: slice(referenceSample) })
	);
}

describeEquipped('gate 4 — minimum sample', () => {
	it('the floor is 400 calibration sends per arm', () => {
		expect(FLOOR).toBe(400);
	});

	it('HOLDS at 399 own-arm calibration sends', () => {
		const result = verdict(FLOOR - 1, 10_000);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_sample_below_floor');
		expect(result.measurement.ownSample).toBe(399);
		expect(result.measurement.minSample).toBe(RAMP_GATE_SAMPLE_FLOORS.engagement);
	});

	it('decides at exactly 400 own-arm calibration sends', () => {
		const result = verdict(FLOOR, 10_000);
		expect(result.status).toBe('pass');
		expect(result.measurement.ownSample).toBe(400);
	});

	it('HOLDS at 399 reference-arm calibration sends, independently of the own arm', () => {
		const result = verdict(10_000, FLOOR - 1);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('reference_sample_below_floor');
		expect(result.measurement.referenceSample).toBe(399);
		// Each floor is reported against the arm it governs. The concurrent ratio's
		// two arms happen to share a floor, so this pins the coincidence rather than
		// assuming it — the floor gate's two differ by 3x.
		expect(result.measurement.minSample).toBe(RAMP_GATE_SAMPLE_FLOORS.engagement);
		expect(result.measurement.referenceMinSample).toBe(RAMP_GATE_SAMPLE_FLOORS.engagement);
	});

	it('decides at exactly 400 reference-arm calibration sends', () => {
		expect(verdict(10_000, FLOOR).status).toBe('pass');
	});

	it('names the OWN arm first when both arms are thin', () => {
		const result = verdict(10, 10);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_sample_below_floor');
	});

	it('a huge stratified volume does not lift a thin calibration slice over the floor', () => {
		const own = arm({
			sent: 500_000,
			opened: 250_000,
			calibrationSent: 12,
			calibrationOpened: 3,
		});
		const result = evaluateEngagementRatioGate(engagementInput({ own, reference: slice(10_000) }));
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_sample_below_floor');
		expect(result.measurement.ownSample).toBe(12);
	});

	it('never returns a verdict below the floor, at any sample from 0 to 399', () => {
		for (const sample of [0, 1, 7, 100, 250, 398, 399]) {
			expect(verdict(sample, 10_000).status).toBe('insufficient_data');
		}
	});
});
