/**
 * Gate 4 — ADVERSARIAL INPUTS.
 *
 * Hostile and degenerate evidence: NaN and infinite rates, negative counters, a
 * calibration slice of size zero, counts that exceed `sent`, a clock that has
 * skewed into the future and a `now` that is not a number at all.
 *
 * ONE property ties every case together: NO poisoned input may produce a `pass`.
 * A `pass` is the only verdict that lets the AIMD controller raise a share, so
 * garbage must land on `insufficient_data` (hold) or `fail` (retreat) — never on
 * the one verdict that spends reputation.
 */

import { describe, expect, it } from 'vitest';
import type { TransportOutcomeSummary } from '../../../analytics/transportOutcomeSummary';
import {
	evaluateEngagementFloorGate,
	evaluateEngagementGate,
	evaluateEngagementRatioGate,
} from '../engagementGate';
import { NOW, arm, engagementArm, engagementInput } from './gateFixtures';

const HEALTHY = engagementArm({ sent: 20_000, calibrationSent: 2_000, calibrationOpened: 400 });

/** A healthy arm with one derived field deliberately poisoned. */
function poisoned(overrides: Partial<TransportOutcomeSummary>): TransportOutcomeSummary {
	return arm({ sent: 20_000, calibrationSent: 2_000, calibrationOpened: 400 }, overrides);
}

describe('gate 4 — adversarial inputs', () => {
	it('HOLDS on a NaN own rate rather than dividing by it', () => {
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: poisoned({ calibrationOpenRate: Number.NaN }), reference: HEALTHY })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_rate_unmeasurable');
	});

	it('HOLDS on a NaN reference rate', () => {
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: HEALTHY, reference: poisoned({ calibrationOpenRate: Number.NaN }) })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('reference_rate_unmeasurable');
	});

	it('HOLDS on an infinite rate', () => {
		expect(
			evaluateEngagementRatioGate(
				engagementInput({
					own: poisoned({ calibrationOpenRate: Number.POSITIVE_INFINITY }),
					reference: HEALTHY,
				})
			).status
		).toBe('insufficient_data');
	});

	it('HOLDS on a negative rate', () => {
		expect(
			evaluateEngagementRatioGate(
				engagementInput({ own: poisoned({ calibrationOpenRate: -0.5 }), reference: HEALTHY })
			).status
		).toBe('insufficient_data');
	});

	it('CLAMPS a rate above 1 (counts exceeding sent) instead of trusting it', () => {
		// Degenerate in the SAFE direction for the own arm, so it still decides —
		// but it may not report an engagement rate of 150%.
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: poisoned({ calibrationOpenRate: 1.5 }), reference: HEALTHY })
		);
		expect(result.status).toBe('pass');
		expect(result.measurement.ownRate).toBe(1);
	});

	it('CLAMPS a reference rate above 1, which can only make the gate stricter', () => {
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: HEALTHY, reference: poisoned({ calibrationOpenRate: 4 }) })
		);
		expect(result.measurement.referenceRate).toBe(1);
		expect(result.status).toBe('fail');
	});

	it('the summarizer already clamps counts that exceed sent', () => {
		const overCounted = engagementArm({
			sent: 1_000,
			calibrationSent: 1_000,
			calibrationOpened: 5_000,
		});
		expect(overCounted.calibrationOpenRate).toBe(1);
	});

	it('HOLDS on a calibration slice of size zero on either arm', () => {
		const empty = engagementArm({ sent: 20_000, calibrationSent: 0 });
		expect(
			evaluateEngagementRatioGate(engagementInput({ own: empty, reference: HEALTHY })).reason
		).toBe('own_sample_below_floor');
		expect(
			evaluateEngagementRatioGate(engagementInput({ own: HEALTHY, reference: empty })).reason
		).toBe('reference_sample_below_floor');
	});

	it('HOLDS on negative counters — a negative sample is not a sample', () => {
		const negative = engagementArm({
			sent: 20_000,
			calibrationSent: -5_000,
			calibrationOpened: -100,
		});
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: negative, reference: HEALTHY })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.measurement.ownSample).toBe(0);
	});

	it('HOLDS on future-dated evidence beyond the skew allowance', () => {
		const skewed = engagementArm({
			sent: 20_000,
			calibrationSent: 2_000,
			calibrationOpened: 400,
			lastRecordedAt: NOW + 30 * 24 * 60 * 60 * 1000,
		});
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: skewed, reference: HEALTHY })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_evidence_stale');
	});

	it('HOLDS on stale evidence', () => {
		const old = engagementArm({
			sent: 20_000,
			calibrationSent: 2_000,
			calibrationOpened: 400,
			lastRecordedAt: NOW - 30 * 24 * 60 * 60 * 1000,
		});
		expect(
			evaluateEngagementRatioGate(engagementInput({ own: old, reference: HEALTHY })).reason
		).toBe('own_evidence_stale');
	});

	it('HOLDS on a missing observation timestamp', () => {
		const undated = engagementArm({
			sent: 20_000,
			calibrationSent: 2_000,
			calibrationOpened: 400,
			lastRecordedAt: null,
		});
		expect(
			evaluateEngagementRatioGate(engagementInput({ own: undated, reference: HEALTHY })).status
		).toBe('insufficient_data');
	});

	it('HOLDS when `now` itself is not a number', () => {
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: HEALTHY, reference: HEALTHY, now: Number.NaN })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_evidence_stale');
	});

	it('the floor gate holds on every poisoned baseline too', () => {
		for (const baseline of [
			poisoned({ calibrationOpenRate: Number.NaN }),
			poisoned({ calibrationOpenRate: -1 }),
			engagementArm({ sent: 20_000, calibrationSent: 0 }),
			engagementArm({
				sent: 20_000,
				calibrationSent: 4_000,
				calibrationOpened: 400,
				lastRecordedAt: null,
			}),
		]) {
			const result = evaluateEngagementFloorGate(
				engagementInput({ own: HEALTHY, ownTrailingBaseline: baseline })
			);
			expect(result.status).toBe('insufficient_data');
		}
	});

	it('NO poisoned input ever produces a pass out of the composed gate 4', () => {
		const garbage: readonly TransportOutcomeSummary[] = [
			poisoned({ calibrationOpenRate: Number.NaN }),
			poisoned({ calibrationOpenRate: Number.NEGATIVE_INFINITY }),
			poisoned({ calibrationOpenRate: -3 }),
			engagementArm({ sent: 0, calibrationSent: 0 }),
			engagementArm({ sent: 20_000, calibrationSent: 2_000, calibrationOpened: 0 }),
		];
		for (const own of garbage) {
			for (const reference of garbage) {
				expect(evaluateEngagementGate(engagementInput({ own, reference })).status).not.toBe('pass');
			}
		}
	});
});
