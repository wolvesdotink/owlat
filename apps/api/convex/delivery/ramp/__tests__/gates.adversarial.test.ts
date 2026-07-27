/**
 * Hostile and degenerate inputs. The contract under attack is simple and
 * absolute: NOTHING here may throw, and NOTHING here may return `pass`.
 *
 * A crafted snapshot that talks the controller into a `pass` is the whole
 * threat model of this module — a zero-volume cell, a poisoned bucket, a
 * clock-skewed MTA or a negative counter must all land on `insufficient_data`
 * (hold) or `fail`, never on the verdict that raises the share.
 */

import { describe, expect, it } from 'vitest';
import {
	evaluateComplaintGate,
	evaluateDeferralGate,
	evaluateHardBounceGate,
	evaluateSeedPlacementGate,
} from '../gates';
import { aggregateRampGates, referenceArmGateEvaluator } from '../gateEvaluation';
import { RAMP_GATE_THRESHOLDS } from '../gateConfig';
import type { RampGateEvaluation, RampGateEvaluationInput, RampGateResult } from '../gateTypes';
import { arm, input, NOW, seeds } from './gateFixtures';

function evaluate(built: RampGateEvaluationInput): RampGateEvaluation {
	return referenceArmGateEvaluator.evaluate(built);
}

const GATES = [
	evaluateHardBounceGate,
	evaluateDeferralGate,
	evaluateComplaintGate,
	evaluateSeedPlacementGate,
] as const;

function everyGate(name: string, build: () => RampGateEvaluationInput): void {
	it(`${name}: no gate throws and no gate passes`, () => {
		const built = build();
		for (const gate of GATES) {
			const result = gate(built);
			expect(result.status).not.toBe('pass');
		}
		expect(evaluate(built).verdict).not.toBe('pass');
	});
}

describe('degenerate volumes', () => {
	everyGate('a zero-volume cell (0/0 everywhere)', () =>
		input({ own: arm({ sent: 0 }), reference: arm({ sent: 0 }), ownSeeds: seeds(0, 0) })
	);

	everyGate('a cell with sends but no observations at all', () =>
		input({ own: arm({ sent: 10_000, lastRecordedAt: null }), reference: arm({ sent: 10_000 }) })
	);

	everyGate('negative counters', () =>
		input({
			own: arm({ sent: -10_000, hardBounced: -5, deferred: -5, complained: -5 }),
			reference: arm({ sent: -10_000 }),
			ownSeeds: seeds(-10, -10, -10),
		})
	);
});

describe('poisoned rates', () => {
	everyGate('NaN rates on both arms', () =>
		input({
			own: arm(
				{ sent: 10_000 },
				{
					hardBounceRate: Number.NaN,
					deferralRate: Number.NaN,
					complaintRate: Number.NaN,
				}
			),
			reference: arm(
				{ sent: 10_000 },
				{
					hardBounceRate: Number.NaN,
					deferralRate: Number.NaN,
					complaintRate: Number.NaN,
				}
			),
		})
	);

	everyGate('Infinity rates on both arms', () =>
		input({
			own: arm(
				{ sent: 10_000 },
				{
					hardBounceRate: Number.POSITIVE_INFINITY,
					deferralRate: Number.POSITIVE_INFINITY,
					complaintRate: Number.POSITIVE_INFINITY,
				}
			),
			reference: arm({ sent: 10_000 }),
		})
	);

	everyGate('negative rates (a subtraction that lost its guard)', () =>
		input({
			own: arm({ sent: 10_000 }, { hardBounceRate: -1, deferralRate: -1, complaintRate: -1 }),
			reference: arm({ sent: 10_000 }),
		})
	);

	it('counts that exceed `sent` clamp to 1 and FAIL rather than being dropped', () => {
		const built = input({
			own: arm({ sent: 100, hardBounced: 10_000 }, { hardBounceRate: 100, sent: 10_000 }),
			reference: arm({ sent: 10_000 }),
		});
		const result = evaluateHardBounceGate(built);
		expect(result.status).toBe('fail');
		expect(result.measurement.ownRate).toBe(1);
	});

	it('a reference arm crafted to look perfect cannot lift an own arm over its ceiling', () => {
		const result = evaluateComplaintGate(
			input({
				own: arm({ sent: 100_000, complained: 50_000 }),
				reference: arm({ sent: 100_000, complained: 49_000 }),
			})
		);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('absolute_threshold_breached');
	});
});

describe('clock skew', () => {
	everyGate('evidence recorded far in the future', () =>
		input({
			own: arm({ sent: 10_000, lastRecordedAt: NOW + 30 * 24 * 60 * 60 * 1000 }),
			reference: arm({ sent: 10_000 }),
			ownSeeds: seeds(20, 0, 0, NOW + 30 * 24 * 60 * 60 * 1000),
			referenceSeeds: seeds(20, 0),
		})
	);

	everyGate('a NaN clock', () =>
		input({ own: arm({ sent: 10_000 }), reference: arm({ sent: 10_000 }), now: Number.NaN })
	);

	it('tolerates skew inside the allowance', () => {
		const built = input({
			own: arm({ sent: 10_000, lastRecordedAt: NOW + RAMP_GATE_THRESHOLDS.maxFutureSkewMs }),
			reference: arm({ sent: 10_000 }),
		});
		expect(evaluateHardBounceGate(built).status).toBe('pass');
	});
});

describe('missing arms and missing gates', () => {
	it('the reference arm is entirely missing: the two-armed gates hold, the one-armed gate still decides', () => {
		const built = input({ own: arm({ sent: 10_000 }), reference: null });
		expect(evaluateHardBounceGate(built).status).toBe('insufficient_data');
		expect(evaluateComplaintGate(built).status).toBe('insufficient_data');
		expect(evaluateSeedPlacementGate(built).status).toBe('insufficient_data');
		// Deferral is one-armed by design (plan D2: a missing relay slows the ramp
		// and does nothing else), so it keeps deciding on the own arm alone.
		expect(evaluateDeferralGate(built).status).toBe('pass');
		expect(evaluate(built).verdict).toBe('insufficient_data');
	});

	it('an EMPTY gate list holds without throwing — zero evidence is not a pass', () => {
		expect(() => aggregateRampGates([], 0, NOW)).not.toThrow();
		const evaluation = aggregateRampGates([], 3, NOW);
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.failedGate).toBeUndefined();
		// Hold, both ways: no increase toward K_CLEAN and no reset either (D10).
		expect(evaluation.cleanStreak).toBe(3);
	});

	it('an evaluation whose ONLY gate is an optional hold does not advance the streak', () => {
		const held: RampGateResult = {
			gate: 'seed_placement',
			status: 'insufficient_data',
			reason: 'evidence_absent',
			measurement: {
				ownRate: null,
				referenceRate: null,
				thresholdRate: 0.9,
				toleranceValuePp: 5,
				ownSample: 0,
				referenceSample: null,
				minSample: 5,
			},
		};
		const evaluation = aggregateRampGates([held], 2, NOW);
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.cleanStreak).toBe(2);
	});

	it('a NaN or negative previous streak is treated as zero', () => {
		const clean: readonly RampGateResult[] = [
			{
				gate: 'hard_bounce',
				status: 'pass',
				reason: 'within_threshold',
				measurement: {
					ownRate: 0,
					referenceRate: 0,
					thresholdRate: 0.02,
					toleranceValuePp: 0.5,
					ownSample: 10_000,
					referenceSample: 10_000,
					minSample: 200,
				},
			},
		];
		expect(aggregateRampGates(clean, Number.NaN, NOW).cleanStreak).toBe(1);
		expect(aggregateRampGates(clean, -5, NOW).cleanStreak).toBe(1);
		expect(aggregateRampGates(clean, 2.7, NOW).cleanStreak).toBe(3);
	});

	it('seed observations with only "missing" mailboxes fail rather than divide by zero', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: arm({ sent: 10_000 }),
				ownSeeds: seeds(0, 0, 20),
				referenceSeeds: seeds(20, 0),
			})
		);
		expect(result.status).toBe('fail');
		expect(result.measurement.ownRate).toBe(0);
	});
});
