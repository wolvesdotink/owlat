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
import { NOW, arm, engagementCell, engagementInput } from './gateFixtures';

const HEALTHY = arm({ sent: 20_000, calibrationSent: 2_000, calibrationOpened: 400 });

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

	it('HOLDS on an own rate above 1 rather than clamping it into a pass', () => {
		// The ceiling gates clamp an out-of-range rate because HIGH IS BAD there and
		// the clamp still fails them. Gate 4 inverts that polarity, so a clamp would
		// turn corruption into the one verdict that lets the controller raise a
		// share. Nothing on the real read path can produce this value at all.
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: poisoned({ calibrationOpenRate: 1.5 }), reference: HEALTHY })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_rate_unmeasurable');
		expect(result.measurement.ownRate).toBeNull();
	});

	it('HOLDS on a click rate above 1 on a clicks-gated cell', () => {
		const result = evaluateEngagementRatioGate(
			engagementInput({
				cell: engagementCell('apple'),
				own: poisoned({ calibrationClickRate: 4 }),
				reference: HEALTHY,
			})
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_rate_unmeasurable');
	});

	it('HOLDS on a reference rate above 1 — a poisoned denominator is not a denominator', () => {
		const result = evaluateEngagementRatioGate(
			engagementInput({ own: HEALTHY, reference: poisoned({ calibrationOpenRate: 4 }) })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('reference_rate_unmeasurable');
		expect(result.measurement.referenceRate).toBeNull();
	});

	it('the summarizer already clamps counts that exceed sent', () => {
		const overCounted = arm({
			sent: 1_000,
			calibrationSent: 1_000,
			calibrationOpened: 5_000,
		});
		expect(overCounted.calibrationOpenRate).toBe(1);
	});

	it('HOLDS on a calibration slice of size zero on either arm', () => {
		const empty = arm({ sent: 20_000, calibrationSent: 0 });
		expect(
			evaluateEngagementRatioGate(engagementInput({ own: empty, reference: HEALTHY })).reason
		).toBe('own_sample_below_floor');
		expect(
			evaluateEngagementRatioGate(engagementInput({ own: HEALTHY, reference: empty })).reason
		).toBe('reference_sample_below_floor');
	});

	it('HOLDS on negative counters — a negative sample is not a sample', () => {
		const negative = arm({
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
		const skewed = arm({
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
		const old = arm({
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
		const undated = arm({
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
			arm({ sent: 20_000, calibrationSent: 0 }),
			arm({
				sent: 20_000,
				calibrationSent: 4_000,
				calibrationOpened: 400,
				lastRecordedAt: null,
			}),
		]) {
			const result = evaluateEngagementFloorGate(
				engagementInput({ own: HEALTHY, ownPriorBaseline: baseline })
			);
			expect(result.status).toBe('insufficient_data');
		}
	});

	it('NO poisoned input ever produces a pass out of the composed gate 4', () => {
		// Both metrics are poisoned in each fixture so the cross product is garbage
		// on an opens-gated cell AND on a clicks-gated one — a fixture that poisoned
		// only the metric the default cell happens to read would exempt itself from
		// the invariant this suite exists to state.
		const garbage: readonly TransportOutcomeSummary[] = [
			poisoned({ calibrationOpenRate: Number.NaN, calibrationClickRate: Number.NaN }),
			poisoned({
				calibrationOpenRate: Number.NEGATIVE_INFINITY,
				calibrationClickRate: Number.POSITIVE_INFINITY,
			}),
			poisoned({ calibrationOpenRate: -3, calibrationClickRate: -3 }),
			poisoned({ calibrationOpenRate: 1.5, calibrationClickRate: 4 }),
			arm({ sent: 0, calibrationSent: 0 }),
			arm({ sent: 20_000, calibrationSent: 2_000, calibrationOpened: 0, calibrationClicked: 0 }),
		];
		for (const cell of [engagementCell('gmail'), engagementCell('apple')]) {
			for (const own of garbage) {
				for (const reference of garbage) {
					expect(evaluateEngagementGate(engagementInput({ cell, own, reference })).status).not.toBe(
						'pass'
					);
				}
			}
		}
	});
});
