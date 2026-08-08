/**
 * ONE INTERFACE, TWO IMPLEMENTATIONS (plan D3).
 *
 * The controller is written once, so the two evaluators must be
 * indistinguishable to it: same input type, same evaluation type, same
 * precedence, same holding rules, same purity. Everything they disagree about is
 * WHICH SERIES a gate measures against and WHAT ITS VERDICT IS WORTH — never how
 * the answers are folded.
 *
 * This suite runs the aggregator contract against BOTH, so a change that fixes
 * precedence in one and forgets the other fails here rather than in production
 * six weeks later on the deployment nobody runs by hand.
 */

import { describe, expect, it } from 'vitest';
import { referenceArmGateEvaluator, trailingBaselineGateEvaluator } from '../gateEvaluation';
import type { RampGateEvaluationInput, RampGateEvaluator } from '../gateTypes';
import {
	EXTERNAL_DATA_ALLOWED,
	NOW,
	arm,
	describeEquipped,
	healthyInput,
	seeds,
	standaloneInput,
} from './gateFixtures';

interface Implementation {
	readonly name: string;
	readonly evaluator: RampGateEvaluator;
	/** A cell in which every gate this implementation reads is healthy. */
	readonly healthy: (overrides?: Partial<RampGateEvaluationInput>) => RampGateEvaluationInput;
	/** Whether this implementation is measurable in the current matrix leg. */
	readonly needsReferenceArm: boolean;
}

const IMPLEMENTATIONS: readonly Implementation[] = [
	{
		name: 'reference_arm',
		evaluator: referenceArmGateEvaluator,
		healthy: healthyInput,
		needsReferenceArm: true,
	},
	{
		name: 'trailing_baseline',
		evaluator: trailingBaselineGateEvaluator,
		healthy: standaloneInput,
		needsReferenceArm: false,
	},
];

/**
 * In the standalone leg only the implementation a standalone deployment actually
 * runs is exercised — with the SAME contract, from the same table. The parity
 * claim is proved by the equipped leg, where both are present; what this leg
 * proves is that the trailing-baseline half of the table still satisfies that
 * contract with every external input removed.
 */
const RUNNABLE = IMPLEMENTATIONS.filter(
	(implementation) => EXTERNAL_DATA_ALLOWED || !implementation.needsReferenceArm
);

describe.each(RUNNABLE)('$name satisfies the gate interface', (implementation) => {
	const { evaluator, healthy } = implementation;

	it('declares its kind, and the two kinds are distinct', () => {
		expect(['reference_arm', 'trailing_baseline']).toContain(evaluator.kind);
		expect(referenceArmGateEvaluator.kind).not.toBe(trailingBaselineGateEvaluator.kind);
	});

	it('a healthy cell PASSES and advances the clean streak', () => {
		const evaluation = evaluator.evaluate(healthy({ previousCleanStreak: 1 }));
		expect(evaluation.verdict).toBe('pass');
		expect(evaluation.cleanStreak).toBe(2);
		expect(evaluation.failedGate).toBeUndefined();
	});

	it('every evaluation carries the full audit shape (plan D12)', () => {
		const evaluation = evaluator.evaluate(healthy());
		expect(evaluation.evaluatedAt).toBe(NOW);
		expect(evaluation.perGate.length).toBeGreaterThan(0);
		expect(typeof evaluation.increaseEvidence).toBe('boolean');
		expect(typeof evaluation.requiresCorroboration).toBe('boolean');
		for (const gate of evaluation.perGate) {
			expect(gate.measurement).toBeDefined();
			expect(gate.reason).toBeTruthy();
		}
	});

	it('PRECEDENCE: a deferral halt outranks everything else', () => {
		const evaluation = evaluator.evaluate(
			healthy({ own: arm({ sent: 10_000, deferred: 4_000, hardBounced: 500 }) })
		);
		expect(evaluation.verdict).toBe('halt');
		expect(evaluation.failedGate).toBe('deferral');
	});

	it('PRECEDENCE: a fail outranks a hold', () => {
		const evaluation = evaluator.evaluate(
			healthy({
				own: arm({ sent: 10_000, hardBounced: 500 }),
				previousCleanStreak: 3,
			})
		);
		expect(evaluation.verdict).toBe('fail');
		expect(evaluation.cleanStreak).toBe(0);
	});

	it('PRECEDENCE: a hold outranks a pass, and never increases OR decreases the streak', () => {
		const evaluation = evaluator.evaluate(
			healthy({ own: arm({ sent: 10 }), previousCleanStreak: 2 })
		);
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.cleanStreak).toBe(2);
	});

	it('an ABSENT optional gate (no seed mailboxes) never holds the ramp (plan D2)', () => {
		const withSeeds = evaluator.evaluate(healthy({ previousCleanStreak: 0 }));
		const withoutSeeds = evaluator.evaluate(
			healthy({ ownSeeds: null, referenceSeeds: null, previousCleanStreak: 0 })
		);
		expect(withSeeds.verdict).toBe('pass');
		expect(withoutSeeds.verdict).toBe('pass');
	});

	it('a seed collapse fails and is flagged as requiring corroboration (plan D17)', () => {
		const evaluation = evaluator.evaluate(
			healthy({
				ownSeeds: seeds(1, 19),
				// A standalone deployment runs no second sweep, so the collapse has to
				// be visible from the own sweep alone — which is the standalone gate's
				// entire claim.
				...(implementation.needsReferenceArm ? { referenceSeeds: seeds(19, 1) } : {}),
			})
		);
		expect(evaluation.verdict).toBe('fail');
		expect(evaluation.failedGate).toBe('seed_placement');
		expect(evaluation.requiresCorroboration).toBe(true);
	});

	it('is PURE: the same input evaluates to the same output, and the input is not mutated', () => {
		const built = healthy();
		const snapshot = structuredClone(built);
		const first = evaluator.evaluate(built);
		expect(evaluator.evaluate(built)).toEqual(first);
		expect(built).toEqual(snapshot);
	});

	it('does not throw on a degenerate, zero-volume cell', () => {
		expect(() =>
			evaluator.evaluate({
				config: standaloneInput().config,
				own: arm({ sent: 0 }),
				reference: null,
				previousCleanStreak: 0,
				now: NOW,
			})
		).not.toThrow();
	});
});

describeEquipped('the two implementations disagree only where the plan says they do', () => {
	it('the standalone one judges seed placement absolutely; the other judges it against the relay sweep', () => {
		// Exactly at the absolute inbox floor, and 10pp behind a perfect relay
		// sweep: inside the standalone rule, outside the 5pp comparative one.
		const seedCase = { ownSeeds: seeds(18, 2), referenceSeeds: seeds(20, 0) } as const;
		const standalone = trailingBaselineGateEvaluator.evaluate(standaloneInput(seedCase));
		const reference = referenceArmGateEvaluator.evaluate(healthyInput(seedCase));
		expect(standalone.verdict).toBe('pass');
		expect(reference.verdict).toBe('fail');
		expect(reference.failedGate).toBe('seed_placement');
	});

	it('the standalone one reads the trailing baseline where the other reads the relay arm', () => {
		// A cell whose bounce rate has TRIPLED against its own history but is level
		// with the relay arm: the trailing implementation must see it, the concurrent
		// one must not.
		// Deferrals counted in both legs: the case is about WHICH SERIES gate 1
		// compares against, so gate 2 must be decidable on either side rather than
		// holding for want of an instrument.
		const own = arm({ sent: 10_000, hardBounced: 150, deferred: 100 });
		const standalone = trailingBaselineGateEvaluator.evaluate(
			standaloneInput({ own, ownTrailingBaseline: arm({ sent: 40_000, hardBounced: 200 }) })
		);
		const reference = referenceArmGateEvaluator.evaluate(
			healthyInput({ own, reference: arm({ sent: 10_000, hardBounced: 150 }) })
		);
		expect(standalone.verdict).toBe('fail');
		expect(standalone.failedGate).toBe('hard_bounce');
		expect(reference.verdict).toBe('pass');
	});
});
