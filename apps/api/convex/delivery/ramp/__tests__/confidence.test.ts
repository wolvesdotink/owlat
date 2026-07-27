/**
 * EVERY VERDICT CARRIES ITS CONFIDENCE (plan D14).
 *
 * The UI renders it, the audit row records it, and the aggregator folds it to the
 * cell's weakest link — so "measurement confidence: low — connect a relay or add
 * seed mailboxes to improve" is a fact the decision core produced, not a sentence
 * the front end guessed at.
 *
 * The per-gate levels are the plan's, and they are asserted as a TABLE rather
 * than case by case: a future gate that forgets to grade itself, or grades itself
 * generously, fails here.
 */

import { describe, expect, it } from 'vitest';
import {
	aggregateRampGates,
	referenceArmGateEvaluator,
	trailingBaselineGateEvaluator,
} from '../gateEvaluation';
import { weakestConfidence, type RampGateConfidence, type RampGateId } from '../gateTypes';
import { NOW, arm, healthyInput, seeds, standaloneInput } from './gateFixtures';

const LEVELS: readonly RampGateConfidence[] = ['high', 'medium', 'low'];

/**
 * The documented per-gate confidence of each implementation — the plan's "gates,
 * degraded honestly" table, as data.
 */
const REFERENCE_ARM_CONFIDENCE: Readonly<Record<RampGateId, RampGateConfidence>> = {
	hard_bounce: 'high',
	deferral: 'high',
	complaint: 'high',
	engagement_ratio: 'high',
	seed_placement: 'medium',
};

const TRAILING_BASELINE_CONFIDENCE: Readonly<Record<RampGateId, RampGateConfidence>> = {
	// Bounce processing and the SMTP conversation are entirely self-hosted.
	hard_bounce: 'high',
	deferral: 'high',
	// The unsubscribe proxy: real evidence, second-hand, and labelled as such.
	complaint: 'medium',
	// Week against month, with nothing held constant.
	engagement_ratio: 'low',
	seed_placement: 'medium',
};

describe('every verdict carries a documented confidence level', () => {
	it('the reference-arm evaluator grades each gate as documented', () => {
		const evaluation = referenceArmGateEvaluator.evaluate(healthyInput());
		for (const gate of evaluation.perGate) {
			expect(LEVELS).toContain(gate.confidence);
			expect(gate.confidence).toBe(REFERENCE_ARM_CONFIDENCE[gate.gate]);
		}
	});

	it('the standalone evaluator grades each gate as documented', () => {
		const evaluation = trailingBaselineGateEvaluator.evaluate(standaloneInput());
		for (const gate of evaluation.perGate) {
			expect(LEVELS).toContain(gate.confidence);
			expect(gate.confidence).toBe(TRAILING_BASELINE_CONFIDENCE[gate.gate]);
		}
	});

	it('a HOLD carries a confidence too — "we could not measure this" is a verdict', () => {
		const evaluation = trailingBaselineGateEvaluator.evaluate(
			standaloneInput({ own: arm({ sent: 10 }) })
		);
		expect(evaluation.verdict).toBe('insufficient_data');
		for (const gate of evaluation.perGate) {
			expect(LEVELS).toContain(gate.confidence);
		}
	});

	it('the complaint gate is HIGH with a feedback loop and MEDIUM on the proxy', () => {
		const withFeedback = trailingBaselineGateEvaluator.evaluate(
			standaloneInput({ hasComplaintFeedback: true })
		);
		const withProxy = trailingBaselineGateEvaluator.evaluate(standaloneInput());
		const complaintOf = (gates: (typeof withFeedback)['perGate']): RampGateConfidence | undefined =>
			gates.find((gate) => gate.gate === 'complaint')?.confidence;
		expect(complaintOf(withFeedback.perGate)).toBe('high');
		expect(complaintOf(withProxy.perGate)).toBe('medium');
	});
});

describe('the evaluation reports the cell’s weakest link', () => {
	it('folds to the lowest contributing confidence, never an average', () => {
		expect(weakestConfidence(['high', 'high'])).toBe('high');
		expect(weakestConfidence(['high', 'medium'])).toBe('medium');
		expect(weakestConfidence(['high', 'medium', 'low'])).toBe('low');
	});

	it('an evaluation with NOTHING contributing reports LOW, not HIGH', () => {
		// An empty fold would otherwise start at `high` and stay there — the exact
		// inversion an operator must never be shown.
		const evaluation = aggregateRampGates({ perGate: [], previousCleanStreak: 0, now: NOW });
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.confidence).toBe('low');
	});

	it('a zero-volume cell still reports the confidence of the instruments it HAS', () => {
		// The gates all hold, but they are present and graded: "we could not measure
		// this, with a medium-confidence instrument" is a more useful sentence than
		// an unconditional "low", and it is the honest one.
		const evaluation = trailingBaselineGateEvaluator.evaluate({
			config: standaloneInput().config,
			own: arm({ sent: 0 }),
			reference: null,
			previousCleanStreak: 0,
			now: NOW,
		});
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.confidence).toBe('medium');
	});

	it('a healthy relay-backed cell measures at HIGH', () => {
		expect(referenceArmGateEvaluator.evaluate(healthyInput()).confidence).toBe('high');
	});

	it('a healthy standalone cell measures at MEDIUM — the proxy is the weakest link', () => {
		expect(trailingBaselineGateEvaluator.evaluate(standaloneInput()).confidence).toBe('medium');
	});

	it('a seed FAIL drags the reported confidence down to the tripwire’s level', () => {
		const evaluation = referenceArmGateEvaluator.evaluate(healthyInput({ ownSeeds: seeds(1, 19) }));
		expect(evaluation.failedGate).toBe('seed_placement');
		expect(evaluation.confidence).toBe('medium');
	});
});
