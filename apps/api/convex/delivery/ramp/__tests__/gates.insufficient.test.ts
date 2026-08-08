/**
 * MINIMUM SAMPLE is enforced, not advisory (plan D10). A gate returning a
 * verdict below its minimum sample is a defect: the controller must not
 * increase on thin data, and must not DECREASE on it either — which is why a
 * catastrophic rate over 5 sends still returns `insufficient_data`.
 *
 * Both arms are checked independently: a thin own arm and a thin reference arm
 * are different reasons, and each on its own is enough to hold the gate.
 */

import { describe, expect, it } from 'vitest';
import { evaluateComplaintGate, evaluateDeferralGate, evaluateHardBounceGate } from '../gates';
import { evaluateSeedPlacementGate } from '../seedGate';
import { aggregateRampGates } from '../gateEvaluation';
import { OPTIONAL_RAMP_GATES, RAMP_GATE_SAMPLE_FLOORS, RAMP_GATE_THRESHOLDS } from '../gateConfig';
import { arm, describeEquipped, input, NOW, seeds } from './gateFixtures';

const STALE_AT = NOW - RAMP_GATE_THRESHOLDS.maxEvidenceAgeMs - 1;

describeEquipped('gate 1 — hard bounce minimum sample', () => {
	it('holds one send below the floor even at a 100% hard-bounce rate', () => {
		const sent = RAMP_GATE_SAMPLE_FLOORS.hardBounce - 1;
		const result = evaluateHardBounceGate(
			input({
				own: arm({ sent, hardBounced: sent }),
				reference: arm({ sent: 10_000, hardBounced: 10 }),
			})
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_sample_below_floor');
		expect(result.measurement.ownSample).toBe(sent);
		expect(result.measurement.minSample).toBe(RAMP_GATE_SAMPLE_FLOORS.hardBounce);
	});

	it('decides exactly ON the floor', () => {
		const sent = RAMP_GATE_SAMPLE_FLOORS.hardBounce;
		const result = evaluateHardBounceGate(input({ own: arm({ sent }), reference: arm({ sent }) }));
		expect(result.status).toBe('pass');
	});

	it('holds when the reference arm is one send below the floor', () => {
		const result = evaluateHardBounceGate(
			input({
				own: arm({ sent: 10_000, hardBounced: 10 }),
				reference: arm({ sent: RAMP_GATE_SAMPLE_FLOORS.hardBounce - 1 }),
			})
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('reference_sample_below_floor');
	});

	it('holds when there is no reference arm at all — absence is never a failure (D2)', () => {
		const result = evaluateHardBounceGate(
			input({ own: arm({ sent: 10_000, hardBounced: 10 }), reference: null })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('evidence_absent');
		expect(result.measurement.referenceSample).toBeNull();
	});

	it('holds on stale own evidence, and on stale reference evidence', () => {
		expect(
			evaluateHardBounceGate(
				input({
					own: arm({ sent: 10_000, lastRecordedAt: STALE_AT }),
					reference: arm({ sent: 10_000 }),
				})
			)
		).toMatchObject({ status: 'insufficient_data', reason: 'own_evidence_stale' });

		expect(
			evaluateHardBounceGate(
				input({
					own: arm({ sent: 10_000 }),
					reference: arm({ sent: 10_000, lastRecordedAt: STALE_AT }),
				})
			)
		).toMatchObject({ status: 'insufficient_data', reason: 'reference_evidence_stale' });
	});
});

describe('gate 2 — deferral minimum sample', () => {
	it('does NOT halt below the floor: a 100% deferral rate over 199 sends holds', () => {
		const sent = RAMP_GATE_SAMPLE_FLOORS.deferral - 1;
		const result = evaluateDeferralGate(input({ own: arm({ sent, deferred: sent }) }));
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_sample_below_floor');
	});

	it('halts exactly ON the floor', () => {
		const sent = RAMP_GATE_SAMPLE_FLOORS.deferral;
		const result = evaluateDeferralGate(input({ own: arm({ sent, deferred: sent }) }));
		expect(result.status).toBe('halt');
	});

	it('holds on stale evidence rather than halting on it', () => {
		const result = evaluateDeferralGate(
			input({ own: arm({ sent: 10_000, deferred: 10_000, lastRecordedAt: STALE_AT }) })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_evidence_stale');
	});
});

/**
 * GATE 2's OTHER WAY OF KNOWING NOTHING (see `hasDeferralTelemetry`).
 *
 * The sample floor above answers "is this window big enough to speak about". This
 * answers a question no sample size can: the `deferred` counter is only partly
 * instrumented, so an empty numerator over an ample window is either a clean cell
 * or a cell nobody records deferrals for — and the second one must not buy the
 * `pass` that lets the controller raise a share.
 */
describe('gate 2 — an uninstrumented zero is not a clean window', () => {
	const AMPLE = 10_000;

	it('holds an ample, spotless window when nothing has recorded a deferral', () => {
		const result = evaluateDeferralGate(input({ own: arm({ sent: AMPLE }) }));
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_deferral_telemetry_absent');
		// The rate IS zero and the sample IS ample — which is exactly why the
		// verdict may not be read off them.
		expect(result.measurement.ownRate).toBe(0);
		expect(result.measurement.ownSample).toBe(AMPLE);
	});

	it('passes the same window once the reader says the counter has a writer', () => {
		const result = evaluateDeferralGate(
			input({ own: arm({ sent: AMPLE }), hasDeferralTelemetry: true })
		);
		expect(result.status).toBe('pass');
		expect(result.reason).toBe('within_threshold');
		expect(result.mayJustifyIncrease).toBe(true);
	});

	it('a window that recorded deferrals is its own witness, flag or no flag', () => {
		for (const hasDeferralTelemetry of [undefined, false]) {
			const result = evaluateDeferralGate(
				input({ own: arm({ sent: AMPLE, deferred: 1 }), hasDeferralTelemetry })
			);
			expect(result.status).toBe('pass');
		}
	});

	it('never suppresses a breach: an absent flag cannot turn a fail or a halt into a hold', () => {
		const failing = evaluateDeferralGate(
			input({
				own: arm({
					sent: AMPLE,
					deferred: Math.round(AMPLE * (RAMP_GATE_THRESHOLDS.deferralMax + 0.01)),
				}),
			})
		);
		expect(failing).toMatchObject({ status: 'fail', reason: 'absolute_threshold_breached' });

		const halting = evaluateDeferralGate(
			input({
				own: arm({ sent: AMPLE, deferred: Math.round(AMPLE * RAMP_GATE_THRESHOLDS.deferralHalt) }),
			})
		);
		expect(halting).toMatchObject({ status: 'halt', reason: 'halt_threshold_breached' });
	});

	it('a thin window is reported as thin, not as uninstrumented', () => {
		// Ordering: the sample floor is the earlier, more fundamental problem, and a
		// hold reason exists to name the thing to fix (plan D12).
		const result = evaluateDeferralGate(
			input({ own: arm({ sent: RAMP_GATE_SAMPLE_FLOORS.deferral - 1 }) })
		);
		expect(result.reason).toBe('own_sample_below_floor');
	});

	it('holding on an absent instrument costs the aggregate its increase evidence', () => {
		// The whole point of the hold: `insufficient_data` outranks `pass` in
		// `aggregateRampGates`, so a cell whose deferral gate cannot measure anything
		// stops advancing rather than advancing on a zero nobody wrote.
		const uninstrumented = aggregateRampGates({
			perGate: [evaluateDeferralGate(input({ own: arm({ sent: AMPLE }) }))],
			previousCleanStreak: 2,
			now: NOW,
		});
		expect(uninstrumented.verdict).toBe('insufficient_data');
		expect(uninstrumented.increaseEvidence).toBe(false);
		// A hold HOLDS the streak (plan D10) — it is neither clean nor dirty.
		expect(uninstrumented.cleanStreak).toBe(2);

		const instrumented = aggregateRampGates({
			perGate: [
				evaluateDeferralGate(input({ own: arm({ sent: AMPLE }), hasDeferralTelemetry: true })),
			],
			previousCleanStreak: 2,
			now: NOW,
		});
		expect(instrumented.verdict).toBe('pass');
		expect(instrumented.increaseEvidence).toBe(true);
		expect(instrumented.cleanStreak).toBe(3);
	});
});

describeEquipped('gate 3 — complaint minimum sample', () => {
	it('holds one send below the floor even at a 100% complaint rate', () => {
		const sent = RAMP_GATE_SAMPLE_FLOORS.complaint - 1;
		const result = evaluateComplaintGate(
			input({ own: arm({ sent, complained: sent }), reference: arm({ sent: 100_000 }) })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_sample_below_floor');
	});

	it('holds when only the reference arm is thin', () => {
		const result = evaluateComplaintGate(
			input({
				own: arm({ sent: 100_000, complained: 20 }),
				reference: arm({ sent: RAMP_GATE_SAMPLE_FLOORS.complaint - 1 }),
			})
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('reference_sample_below_floor');
	});

	it('decides exactly ON the floor', () => {
		const sent = RAMP_GATE_SAMPLE_FLOORS.complaint;
		const result = evaluateComplaintGate(input({ own: arm({ sent }), reference: arm({ sent }) }));
		expect(result.status).toBe('pass');
	});
});

describeEquipped('gate 5 — seed placement minimum sample (optional gate)', () => {
	it('holds below the seed floor, and the gate is one the ramp treats as optional', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: arm({ sent: 10_000 }),
				ownSeeds: seeds(0, RAMP_GATE_SAMPLE_FLOORS.seedPlacement - 1),
				referenceSeeds: seeds(10, 0),
			})
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_sample_below_floor');
		expect(OPTIONAL_RAMP_GATES.has(result.gate)).toBe(true);
	});

	it('absent own seed data holds and never fails (D2)', () => {
		const result = evaluateSeedPlacementGate(input({ own: arm({ sent: 10_000 }) }));
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('evidence_absent');
		expect(result.measurement.ownRate).toBeNull();
		expect(result.measurement.ownSample).toBe(0);
	});

	it('absent reference seed data holds even when own placement is perfect', () => {
		const result = evaluateSeedPlacementGate(
			input({ own: arm({ sent: 10_000 }), ownSeeds: seeds(20, 0) })
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('evidence_absent');
	});

	it('holds on stale seed observations', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: arm({ sent: 10_000 }),
				ownSeeds: seeds(20, 0, 0, { observedAt: STALE_AT }),
				referenceSeeds: seeds(20, 0),
			})
		);
		expect(result.status).toBe('insufficient_data');
		expect(result.reason).toBe('own_evidence_stale');
	});
});

describeEquipped(
	'the own-arm absolute breach is the one thing thin reference data cannot suppress',
	() => {
		it('fails on an ample own arm over the ceiling with no reference arm at all', () => {
			const result = evaluateHardBounceGate(
				input({ own: arm({ sent: 10_000, hardBounced: 2_000 }), reference: null })
			);
			expect(result.status).toBe('fail');
			expect(result.reason).toBe('absolute_threshold_breached');
		});

		it('fails on an ample own arm over the ceiling with a thin reference arm', () => {
			const result = evaluateComplaintGate(
				input({
					own: arm({ sent: 100_000, complained: 1_000 }),
					reference: arm({ sent: 10 }),
				})
			);
			expect(result.status).toBe('fail');
			expect(result.reason).toBe('absolute_threshold_breached');
		});
	}
);
