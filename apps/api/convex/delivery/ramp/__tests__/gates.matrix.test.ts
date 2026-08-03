/**
 * Gate threshold MATRIX — every threshold walked from just-below, to exactly
 * on, to just-above, asserting the returned NUMBERS as well as the verdict.
 *
 * The boundaries are inclusive-safe by design: a rate exactly ON a ceiling
 * passes, a rate exactly on the deferral HALT halts. Those are the two most
 * dangerous lines in the module, so they are pinned literally.
 */

import { describe, expect, it } from 'vitest';
import { evaluateComplaintGate, evaluateDeferralGate, evaluateHardBounceGate } from '../gates';
import { evaluateSeedPlacementGate } from '../seedGate';
import { OPTIONAL_RAMP_GATES } from '../gateConfig';
import type { RampGateResult, RampGateStatus } from '../gateTypes';
import { arm, armWith, describeEquipped, input, seeds } from './gateFixtures';

interface Case {
	readonly name: string;
	readonly result: () => RampGateResult;
	readonly status: RampGateStatus;
	readonly reason: RampGateResult['reason'];
	readonly ownRate: number;
	readonly referenceRate: number | null;
}

const HARD_BOUNCE_REFERENCE = arm({ sent: 10_000, hardBounced: 100 }); // 1.00%

function hardBounce(ownHardBounced: number): () => RampGateResult {
	return () =>
		evaluateHardBounceGate(
			input({
				own: arm({ sent: 10_000, hardBounced: ownHardBounced }),
				reference: HARD_BOUNCE_REFERENCE,
			})
		);
}

describeEquipped('gate 1 — hard bounce (own <= 2% AND <= reference + 0.5pp)', () => {
	const cases: readonly Case[] = [
		{
			name: 'just below the 2% ceiling',
			result: hardBounce(149),
			status: 'pass',
			reason: 'within_threshold',
			ownRate: 0.0149,
			referenceRate: 0.01,
		},
		{
			name: 'exactly on the 0.5pp tolerance (1.0% + 0.5pp = 1.5%)',
			result: hardBounce(150),
			status: 'pass',
			reason: 'within_threshold',
			ownRate: 0.015,
			referenceRate: 0.01,
		},
		{
			name: 'one send past the tolerance, still under the absolute ceiling',
			result: hardBounce(151),
			status: 'fail',
			reason: 'reference_tolerance_breached',
			ownRate: 0.0151,
			referenceRate: 0.01,
		},
		{
			name: 'exactly on the 2% absolute ceiling (reference lifted to match)',
			result: () =>
				evaluateHardBounceGate(
					input({
						own: arm({ sent: 10_000, hardBounced: 200 }),
						reference: arm({ sent: 10_000, hardBounced: 200 }),
					})
				),
			status: 'pass',
			reason: 'within_threshold',
			ownRate: 0.02,
			referenceRate: 0.02,
		},
		{
			name: 'one send past the 2% absolute ceiling fails even with a matching reference',
			result: () =>
				evaluateHardBounceGate(
					input({
						own: arm({ sent: 10_000, hardBounced: 201 }),
						reference: arm({ sent: 10_000, hardBounced: 201 }),
					})
				),
			status: 'fail',
			reason: 'absolute_threshold_breached',
			ownRate: 0.0201,
			referenceRate: 0.0201,
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			const result = testCase.result();
			expect(result.gate).toBe('hard_bounce');
			expect(result.status).toBe(testCase.status);
			expect(result.reason).toBe(testCase.reason);
			expect(OPTIONAL_RAMP_GATES.has(result.gate)).toBe(false);
			expect(result.measurement.ownRate).toBeCloseTo(testCase.ownRate, 10);
			expect(result.measurement.referenceRate).toBeCloseTo(testCase.referenceRate ?? 0, 10);
			expect(result.measurement.thresholdRate).toBe(0.02);
			expect(result.measurement.toleranceValuePp).toBe(0.5);
			expect(result.measurement.ownSample).toBe(10_000);
			expect(result.measurement.referenceSample).toBe(10_000);
			expect(result.measurement.minSample).toBe(200);
		});
	}
});

describe('gate 2 — deferral (own <= 10%, >= 25% halts)', () => {
	const cases: readonly {
		readonly deferred: number;
		readonly status: RampGateStatus;
		readonly reason: RampGateResult['reason'];
		readonly ownRate: number;
	}[] = [
		{ deferred: 999, status: 'pass', reason: 'within_threshold', ownRate: 0.0999 },
		{ deferred: 1000, status: 'pass', reason: 'within_threshold', ownRate: 0.1 },
		{ deferred: 1001, status: 'fail', reason: 'absolute_threshold_breached', ownRate: 0.1001 },
		{ deferred: 2499, status: 'fail', reason: 'absolute_threshold_breached', ownRate: 0.2499 },
		{ deferred: 2500, status: 'halt', reason: 'halt_threshold_breached', ownRate: 0.25 },
		{ deferred: 2501, status: 'halt', reason: 'halt_threshold_breached', ownRate: 0.2501 },
	];

	for (const testCase of cases) {
		it(`${testCase.deferred} deferrals in 10000 -> ${testCase.status}`, () => {
			const result = evaluateDeferralGate(
				input({ own: arm({ sent: 10_000, deferred: testCase.deferred }) })
			);
			expect(result.gate).toBe('deferral');
			expect(result.status).toBe(testCase.status);
			expect(result.reason).toBe(testCase.reason);
			expect(result.measurement.ownRate).toBeCloseTo(testCase.ownRate, 10);
			expect(result.measurement.thresholdRate).toBe(0.1);
			// The deferral gate is one-armed: the relay's deferral rate says nothing
			// about our sending identity, so there is no reference half to render.
			expect(result.measurement.referenceRate).toBeNull();
			expect(result.measurement.referenceSample).toBeNull();
			expect(result.measurement.toleranceValuePp).toBeNull();
			expect(result.measurement.minSample).toBe(200);
		});
	}

	it('halts with no reference arm configured at all (plan D2)', () => {
		const result = evaluateDeferralGate(
			input({ own: arm({ sent: 10_000, deferred: 2500 }), reference: null })
		);
		expect(result.status).toBe('halt');
	});
});

describeEquipped('gate 3 — complaint (own <= 0.1% AND <= reference + 0.05pp)', () => {
	const reference = arm({ sent: 100_000, complained: 20 }); // 0.02%

	const cases: readonly Case[] = [
		{
			name: 'exactly on the 0.05pp tolerance (0.02% + 0.05pp = 0.07%)',
			result: () =>
				evaluateComplaintGate(input({ own: arm({ sent: 100_000, complained: 70 }), reference })),
			status: 'pass',
			reason: 'within_threshold',
			ownRate: 0.0007,
			referenceRate: 0.0002,
		},
		{
			name: 'past the tolerance but under the absolute ceiling',
			result: () =>
				evaluateComplaintGate(input({ own: arm({ sent: 100_000, complained: 90 }), reference })),
			status: 'fail',
			reason: 'reference_tolerance_breached',
			ownRate: 0.0009,
			referenceRate: 0.0002,
		},
		{
			name: 'exactly on the 0.1% absolute ceiling (reference lifted to match)',
			result: () =>
				evaluateComplaintGate(
					input({
						own: arm({ sent: 100_000, complained: 100 }),
						reference: arm({ sent: 100_000, complained: 100 }),
					})
				),
			status: 'pass',
			reason: 'within_threshold',
			ownRate: 0.001,
			referenceRate: 0.001,
		},
		{
			name: 'one complaint past the 0.1% ceiling fails even with a matching reference',
			result: () =>
				evaluateComplaintGate(
					input({
						own: arm({ sent: 100_000, complained: 101 }),
						reference: arm({ sent: 100_000, complained: 101 }),
					})
				),
			status: 'fail',
			reason: 'absolute_threshold_breached',
			ownRate: 0.00101,
			referenceRate: 0.00101,
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			const result = testCase.result();
			expect(result.gate).toBe('complaint');
			expect(result.status).toBe(testCase.status);
			expect(result.reason).toBe(testCase.reason);
			expect(result.measurement.ownRate).toBeCloseTo(testCase.ownRate, 12);
			expect(result.measurement.referenceRate).toBeCloseTo(testCase.referenceRate ?? 0, 12);
			expect(result.measurement.thresholdRate).toBe(0.001);
			expect(result.measurement.toleranceValuePp).toBe(0.05);
			expect(result.measurement.minSample).toBe(1000);
		});
	}
});

describeEquipped('gate 5 — seed placement (inbox >= 90% AND >= reference - 5pp)', () => {
	it('exactly on the 90% inbox floor passes', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: armWith('hardBounced', 10_000, 0),
				ownSeeds: seeds(18, 2),
				referenceSeeds: seeds(18, 2),
			})
		);
		expect(result.status).toBe('pass');
		expect(result.measurement.ownRate).toBeCloseTo(0.9, 10);
		expect(result.measurement.thresholdRate).toBe(0.9);
		expect(result.measurement.toleranceValuePp).toBe(5);
		expect(result.measurement.ownSample).toBe(20);
	});

	it('one seed below the 90% floor fails', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: armWith('hardBounced', 10_000, 0),
				ownSeeds: seeds(17, 3),
				referenceSeeds: seeds(17, 3),
			})
		);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('absolute_threshold_breached');
		expect(result.measurement.ownRate).toBeCloseTo(0.85, 10);
	});

	it('exactly on the 5pp reference tolerance passes', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: armWith('hardBounced', 10_000, 0),
				ownSeeds: seeds(19, 1),
				referenceSeeds: seeds(20, 0),
			})
		);
		expect(result.status).toBe('pass');
		expect(result.measurement.ownRate).toBeCloseTo(0.95, 10);
		expect(result.measurement.referenceRate).toBe(1);
	});

	it('one seed past the 5pp reference tolerance fails, above the absolute floor', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: armWith('hardBounced', 10_000, 0),
				ownSeeds: seeds(18, 2),
				referenceSeeds: seeds(20, 0),
			})
		);
		expect(result.status).toBe('fail');
		expect(result.reason).toBe('reference_tolerance_breached');
		expect(result.measurement.ownRate).toBeCloseTo(0.9, 10);
		expect(result.measurement.referenceRate).toBe(1);
	});

	it('a tabbed own arm is not below a boxed reference — `category` is reached', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: armWith('hardBounced', 10_000, 0),
				ownSeeds: seeds(2, 0, 0, { category: 18 }),
				referenceSeeds: seeds(20, 0),
			})
		);
		expect(result.status).toBe('pass');
		expect(result.measurement.ownRate).toBe(1);
		expect(result.measurement.referenceRate).toBe(1);
	});

	// The reference arm's `deleted` probes are the discriminator: counted, the
	// reference reaches 70% and the own arm is 20pp ABOVE it; dropped, the
	// reference reads a clean 100% and the same own arm fails the 5pp tolerance.
	it('reads `deleted` on the REFERENCE arm too — it lowers the bar, it is not absent', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: armWith('hardBounced', 10_000, 0),
				ownSeeds: seeds(18, 2),
				referenceSeeds: seeds(14, 0, 0, { deleted: 6 }),
			})
		);
		expect(result.status).toBe('pass');
		expect(result.measurement.ownRate).toBeCloseTo(0.9, 10);
		expect(result.measurement.referenceRate).toBeCloseTo(0.7, 10);
	});

	it('counts missing seeds in the denominator — missing is the loudest outcome (D17)', () => {
		const result = evaluateSeedPlacementGate(
			input({
				own: armWith('hardBounced', 10_000, 0),
				ownSeeds: seeds(18, 0, 2),
				referenceSeeds: seeds(18, 0, 2),
			})
		);
		expect(result.measurement.ownSample).toBe(20);
		expect(result.measurement.ownRate).toBeCloseTo(0.9, 10);
		expect(result.status).toBe('pass');
	});
});
