/**
 * Hostile and degenerate inputs. The contract under attack is simple and
 * absolute: NOTHING here may throw, and NOTHING here may return `pass`.
 *
 * A crafted snapshot that talks the controller into a `pass` is the whole
 * threat model of this module — a zero-volume cell, a poisoned bucket, a
 * clock-skewed MTA or a negative counter must all land on `insufficient_data`
 * (hold) or `fail`, never on the verdict that raises the share.
 */

import { expect, it } from 'vitest';
import type { TransportOutcomeSummary } from '../../../analytics/transportOutcomeSummary';
import {
	evaluateComplaintGate,
	evaluateDeferralGate,
	evaluateHardBounceGate,
	evaluateSeedPlacementGate,
} from '../gates';
import { aggregateRampGates, referenceArmGateEvaluator } from '../gateEvaluation';
import { RAMP_GATE_THRESHOLDS } from '../gateConfig';
import type { RampGateEvaluation, RampGateEvaluationInput, RampGateResult } from '../gateTypes';
import {
	BEYOND_SKEW,
	NOW,
	POISON_RATE_VALUES,
	arm,
	describeEquipped,
	input,
	poisonedRates,
	seeds,
} from './gateFixtures';

function evaluate(built: RampGateEvaluationInput): RampGateEvaluation {
	return referenceArmGateEvaluator.evaluate(built);
}

type RampGate = (built: RampGateEvaluationInput) => RampGateResult;

const GATES: readonly RampGate[] = [
	evaluateHardBounceGate,
	evaluateDeferralGate,
	evaluateComplaintGate,
	evaluateSeedPlacementGate,
];

/** The gates that read an outcome RATE — the ones a poisoned bucket reaches. */
const RATE_GATES: readonly RampGate[] = [
	evaluateHardBounceGate,
	evaluateDeferralGate,
	evaluateComplaintGate,
];

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

describeEquipped('degenerate volumes', () => {
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

describeEquipped('poisoned rates', () => {
	/**
	 * All three fixtures give the own arm an AMPLE, FRESH window and poison only
	 * the derived rate, so the hold cannot be explained by sample size or age.
	 */
	const poisonedOwnArm: ReadonlyArray<readonly [string, () => RampGateEvaluationInput]> = [
		// BOTH arms poisoned, so the own-arm guard is proved to return before the
		// reference-arm one rather than merely happening to.
		[
			'NaN rates on both arms',
			() =>
				input({
					own: arm({ sent: 10_000 }, poisonedRates(Number.NaN)),
					reference: arm({ sent: 10_000 }, poisonedRates(Number.NaN)),
				}),
		],
		// ...and one case per shared poison value with a healthy reference arm.
		...POISON_RATE_VALUES.map(
			([label, value]) =>
				[
					`${label} rates on the own arm`,
					() =>
						input({
							own: arm({ sent: 10_000 }, poisonedRates(value)),
							reference: arm({ sent: 10_000 }),
						}),
				] as const
		),
	];

	for (const [name, build] of poisonedOwnArm) {
		everyGate(name, build);

		// A poisoned bucket is NOT a thin window, and the reason code is what the
		// admin notification renders from (plan D12): reporting an unusable rate as
		// `own_sample_below_floor` sends the operator to the wrong remediation.
		it(`${name}: every rate gate holds with own_rate_unmeasurable`, () => {
			const built = build();
			for (const gate of RATE_GATES) {
				expect(gate(built)).toMatchObject({
					status: 'insufficient_data',
					reason: 'own_rate_unmeasurable',
				});
			}
		});
	}

	// The own-arm guard returns first, so a poisoned own arm can never exercise
	// the reference-arm guard. This is the fixture that does: own arm ample,
	// fresh and healthy, reference arm ample and fresh but unusable.
	const poisonedReferenceArm: ReadonlyArray<{
		readonly field: string;
		readonly gate: RampGate;
		readonly poison: (value: number) => Partial<TransportOutcomeSummary>;
	}> = [
		{
			field: 'hardBounceRate',
			gate: evaluateHardBounceGate,
			poison: (value) => ({ hardBounceRate: value }),
		},
		{
			field: 'complaintRate',
			gate: evaluateComplaintGate,
			poison: (value) => ({ complaintRate: value }),
		},
	];

	for (const { field, gate, poison } of poisonedReferenceArm) {
		for (const [label, value] of POISON_RATE_VALUES) {
			it(`a ${label} ${field} on the REFERENCE arm holds with reference_rate_unmeasurable`, () => {
				const built = input({
					own: arm({ sent: 10_000, hardBounced: 10, complained: 5 }),
					reference: arm({ sent: 10_000, hardBounced: 10, complained: 5 }, poison(value)),
				});
				expect(gate(built)).toMatchObject({
					status: 'insufficient_data',
					reason: 'reference_rate_unmeasurable',
				});
				expect(evaluate(built).verdict).not.toBe('pass');
			});
		}
	}

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

describeEquipped('clock skew', () => {
	everyGate('evidence recorded far in the future', () =>
		input({
			own: arm({ sent: 10_000, lastRecordedAt: BEYOND_SKEW }),
			reference: arm({ sent: 10_000 }),
			ownSeeds: seeds(20, 0, 0, BEYOND_SKEW),
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

describeEquipped('missing arms and missing gates', () => {
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
		expect(() =>
			aggregateRampGates({ perGate: [], previousCleanStreak: 0, now: NOW })
		).not.toThrow();
		const evaluation = aggregateRampGates({ perGate: [], previousCleanStreak: 3, now: NOW });
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
			confidence: 'medium',
			mayJustifyIncrease: true,
		};
		const evaluation = aggregateRampGates({
			perGate: [held],
			previousCleanStreak: 2,
			now: NOW,
		});
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
				confidence: 'high',
				mayJustifyIncrease: true,
			},
		];
		const streak = (previousCleanStreak: number): number =>
			aggregateRampGates({ perGate: clean, previousCleanStreak, now: NOW }).cleanStreak;
		expect(streak(Number.NaN)).toBe(1);
		expect(streak(-5)).toBe(1);
		expect(streak(2.7)).toBe(3);
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
