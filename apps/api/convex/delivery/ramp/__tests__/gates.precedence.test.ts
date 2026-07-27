/**
 * Aggregator PRECEDENCE: halt > fail > insufficient_data > pass.
 *
 * The two rules that are easy to get backwards, and that decide whether a
 * deployment ramps into the spam folder:
 *   - the deferral HALT outranks an ordinary fail (a hard stop, not a decrease);
 *   - `insufficient_data` outranks `pass` (plan D10 — never increase on thin
 *     data), while an OPTIONAL gate's `insufficient_data` is ignored entirely
 *     (plan D2 — an absent external account never holds the ramp).
 */

import { describe, expect, it } from 'vitest';
import { aggregateRampGates, referenceArmGateEvaluator } from '../gateEvaluation';
import type {
	RampGateEvaluation,
	RampGateEvaluationInput,
	RampGateId,
	RampGateResult,
	RampGateStatus,
} from '../gateTypes';
import { arm, healthyInput, input, seeds } from './gateFixtures';

const EVALUATED_AT = 1_700_000_000_000;

function evaluate(built: RampGateEvaluationInput): RampGateEvaluation {
	return referenceArmGateEvaluator.evaluate(built);
}

/**
 * A synthetic gate answer. Optionality is NOT a parameter: it is a property of
 * the gate id, so `seed_placement` is the optional one and nothing else can
 * pretend to be.
 */
function result(gate: RampGateId, status: RampGateStatus): RampGateResult {
	// Every verdict carries a grade (plan D14). These synthetic answers are
	// high-confidence and increase-justifying so that the PRECEDENCE contract is
	// what this suite measures; the asymmetry has its own suite.
	const grade = { confidence: 'high', mayJustifyIncrease: true } as const;
	const shape = {
		thresholdRate: 0,
		toleranceValuePp: null,
		ownSample: 0,
		referenceSample: null,
		minSample: 0,
	} as const;
	switch (status) {
		case 'pass':
			return {
				gate,
				status,
				reason: 'within_threshold',
				measurement: { ...shape, ownRate: 0, referenceRate: null },
				...grade,
			};
		case 'fail':
			return {
				gate,
				status,
				reason: 'absolute_threshold_breached',
				measurement: { ...shape, ownRate: 0, referenceRate: null },
				...grade,
			};
		case 'halt':
			return {
				gate,
				status,
				reason: 'halt_threshold_breached',
				measurement: { ...shape, ownRate: 0, referenceRate: null },
				...grade,
			};
		case 'insufficient_data':
			return {
				gate,
				status,
				reason: 'evidence_absent',
				measurement: { ...shape, ownRate: null, referenceRate: null },
				...grade,
			};
	}
}

describe('aggregateRampGates precedence', () => {
	it('all pass -> pass, no failed gate, streak advances', () => {
		const evaluation = aggregateRampGates({
			perGate: [result('hard_bounce', 'pass'), result('complaint', 'pass')],
			previousCleanStreak: 2,
			now: EVALUATED_AT,
		});
		expect(evaluation.verdict).toBe('pass');
		expect(evaluation.failedGate).toBeUndefined();
		expect(evaluation.cleanStreak).toBe(3);
		expect(evaluation.evaluatedAt).toBe(EVALUATED_AT);
	});

	it('a fail outranks any number of insufficient_data gates', () => {
		const evaluation = aggregateRampGates({
			perGate: [
				result('hard_bounce', 'insufficient_data'),
				result('complaint', 'fail'),
				result('seed_placement', 'insufficient_data'),
			],
			previousCleanStreak: 5,
			now: EVALUATED_AT,
		});
		expect(evaluation.verdict).toBe('fail');
		expect(evaluation.failedGate).toBe('complaint');
		expect(evaluation.cleanStreak).toBe(0);
	});

	it('the deferral halt outranks an ordinary fail regardless of order', () => {
		const failFirst = aggregateRampGates({
			perGate: [result('hard_bounce', 'fail'), result('deferral', 'halt')],
			previousCleanStreak: 4,
			now: EVALUATED_AT,
		});
		expect(failFirst.verdict).toBe('halt');
		expect(failFirst.failedGate).toBe('deferral');

		const haltFirst = aggregateRampGates({
			perGate: [result('deferral', 'halt'), result('hard_bounce', 'fail')],
			previousCleanStreak: 4,
			now: EVALUATED_AT,
		});
		expect(haltFirst.verdict).toBe('halt');
		expect(haltFirst.failedGate).toBe('deferral');
		expect(haltFirst.cleanStreak).toBe(0);
	});

	it('insufficient_data outranks pass and HOLDS the streak', () => {
		const evaluation = aggregateRampGates({
			perGate: [result('hard_bounce', 'pass'), result('complaint', 'insufficient_data')],
			previousCleanStreak: 3,
			now: EVALUATED_AT,
		});
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.failedGate).toBe('complaint');
		expect(evaluation.cleanStreak).toBe(3);
	});

	it('an optional gate holding is ignored; an optional gate failing is not', () => {
		const held = aggregateRampGates({
			perGate: [result('hard_bounce', 'pass'), result('seed_placement', 'insufficient_data')],
			previousCleanStreak: 0,
			now: EVALUATED_AT,
		});
		expect(held.verdict).toBe('pass');
		expect(held.cleanStreak).toBe(1);

		const failed = aggregateRampGates({
			perGate: [result('hard_bounce', 'pass'), result('seed_placement', 'fail')],
			previousCleanStreak: 7,
			now: EVALUATED_AT,
		});
		expect(failed.verdict).toBe('fail');
		expect(failed.failedGate).toBe('seed_placement');
		expect(failed.cleanStreak).toBe(0);
	});

	it('names the FIRST gate at the winning rank', () => {
		const evaluation = aggregateRampGates({
			perGate: [result('hard_bounce', 'fail'), result('complaint', 'fail')],
			previousCleanStreak: 1,
			now: EVALUATED_AT,
		});
		expect(evaluation.failedGate).toBe('hard_bounce');
	});

	it('an evidence-free evaluation HOLDS — `pass` is never the default', () => {
		// Nothing contributed: no gate at all, and then only an optional gate that
		// is holding. `pass` is the one verdict that raises a share (D9), so it
		// must be unreachable from zero evidence (D10).
		const empty = aggregateRampGates({ perGate: [], previousCleanStreak: 2, now: EVALUATED_AT });
		expect(empty.verdict).toBe('insufficient_data');
		expect(empty.failedGate).toBeUndefined();
		expect(empty.cleanStreak).toBe(2);

		const optionalOnly = aggregateRampGates({
			perGate: [result('seed_placement', 'insufficient_data')],
			previousCleanStreak: 2,
			now: EVALUATED_AT,
		});
		expect(optionalOnly.verdict).toBe('insufficient_data');
		expect(optionalOnly.cleanStreak).toBe(2);
	});

	it('flags a tripwire fail as requiring corroboration, and nothing else (D17)', () => {
		const seedFail = aggregateRampGates({
			perGate: [result('hard_bounce', 'pass'), result('seed_placement', 'fail')],
			previousCleanStreak: 0,
			now: EVALUATED_AT,
		});
		expect(seedFail.failedGate).toBe('seed_placement');
		expect(seedFail.requiresCorroboration).toBe(true);

		// A mandatory gate's fail is a measurement, not a tripwire.
		expect(
			aggregateRampGates({
				perGate: [result('hard_bounce', 'fail')],
				previousCleanStreak: 0,
				now: EVALUATED_AT,
			}).requiresCorroboration
		).toBe(false);

		// Already corroborated by a mandatory gate at the same rank: the mandatory
		// gate is the one named, so nothing is pending.
		expect(
			aggregateRampGates({
				perGate: [result('hard_bounce', 'fail'), result('seed_placement', 'fail')],
				previousCleanStreak: 0,
				now: EVALUATED_AT,
			}).requiresCorroboration
		).toBe(false);

		expect(
			aggregateRampGates({
				perGate: [result('hard_bounce', 'pass')],
				previousCleanStreak: 0,
				now: EVALUATED_AT,
			}).requiresCorroboration
		).toBe(false);
	});

	it('carries every gate result through untouched for the audit row (D12)', () => {
		const perGate = [result('hard_bounce', 'pass'), result('deferral', 'fail')];
		expect(
			aggregateRampGates({ perGate, previousCleanStreak: 0, now: EVALUATED_AT }).perGate
		).toEqual(perGate);
	});
});

describe('referenceArmGateEvaluator', () => {
	it('is the reference-arm implementation of the one gate interface (D3)', () => {
		expect(referenceArmGateEvaluator.kind).toBe('reference_arm');
	});

	it('passes a healthy two-armed cell and advances the streak', () => {
		const evaluation = evaluate(healthyInput({ previousCleanStreak: 2 }));
		expect(evaluation.verdict).toBe('pass');
		expect(evaluation.cleanStreak).toBe(3);
		expect(evaluation.perGate.map((gate) => gate.gate)).toEqual([
			'hard_bounce',
			'deferral',
			'complaint',
			'seed_placement',
		]);
	});

	it('includes a supplied engagement result and lets it decide', () => {
		const evaluation = evaluate(healthyInput({ engagement: result('engagement_ratio', 'fail') }));
		expect(evaluation.verdict).toBe('fail');
		expect(evaluation.failedGate).toBe('engagement_ratio');
		expect(evaluation.perGate).toHaveLength(5);
	});

	it('an unmeasured engagement gate contributes nothing rather than holding', () => {
		const evaluation = evaluate(healthyInput({ engagement: null }));
		expect(evaluation.verdict).toBe('pass');
		expect(evaluation.perGate).toHaveLength(4);
	});

	it('holds — never fails — a fresh install with no relay and no seeds (D2)', () => {
		const evaluation = evaluate(
			input({
				own: arm({ sent: 10_000, deferred: 100, hardBounced: 10, complained: 5 }),
				reference: null,
				previousCleanStreak: 4,
			})
		);
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.cleanStreak).toBe(4);
		// The seed gate is absent-but-optional: it must not be what is reported.
		expect(evaluation.failedGate).toBe('hard_bounce');
	});

	it('halts a cell deferring 25% of its mail even with everything else healthy', () => {
		const evaluation = evaluate(
			healthyInput({
				own: arm({ sent: 10_000, deferred: 2_500, hardBounced: 10, complained: 5 }),
				ownSeeds: seeds(20, 0),
				referenceSeeds: seeds(20, 0),
			})
		);
		expect(evaluation.verdict).toBe('halt');
		expect(evaluation.failedGate).toBe('deferral');
	});
});
