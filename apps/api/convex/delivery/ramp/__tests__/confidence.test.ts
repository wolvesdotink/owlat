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
import { weakestConfidence } from '../gateGrades';
import type { RampGateConfidence, RampGateId } from '../gateTypes';
import { NOW, arm, healthyInput, itEquipped, seeds, standaloneInput } from './gateFixtures';

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
	itEquipped('the reference-arm evaluator grades each gate as documented', () => {
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
		expect(evaluation.measuredConfidence).toBe('low');
	});

	/**
	 * A GATE THAT MEASURED NOTHING CONTRIBUTES NOTHING TO THE GRADE, so a window
	 * in which EVERY gate held folds to `low` — not to the level of the
	 * instruments that were merely PRESENT. `measuredConfidence` grades the
	 * verdicts this evaluation reached, and it reached none.
	 *
	 * THIS IS NOT WHAT THE SCREEN SHOWS. `dashboardConfidence` returns `none` for
	 * any cell with `ownSent <= 0` before it looks at this number at all, so a
	 * fully-held window's grade is only ever visible in the D12 audit row. Do not
	 * re-derive a friendlier level here from what an operator would see — they
	 * would see "not measured", which is the same sentence this asserts.
	 */
	it('a window in which EVERY gate held grades LOW — nothing decided, nothing measured', () => {
		const evaluation = trailingBaselineGateEvaluator.evaluate({
			config: standaloneInput().config,
			own: arm({ sent: 0 }),
			reference: null,
			previousCleanStreak: 0,
			now: NOW,
		});
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.perGate.every((gate) => gate.status === 'insufficient_data')).toBe(true);
		expect(evaluation.measuredConfidence).toBe('low');
	});

	/**
	 * THE CLAIM WORTH PINNING: the grade follows the instruments that DECIDED,
	 * even when most of the column is holding.
	 *
	 * A standalone cell with real volume but no 30-day history yet: gates 1 and 3
	 * have no trailing baseline to compare against and hold, gate 5 has no probes
	 * and holds — and the deferral gate, which never depended on a third party or
	 * on history, decides at `high`. "We could not measure most of this, and the
	 * one instrument that did decide is a direct one" is the honest sentence, and
	 * it is the one the audit row records. The CELL is still capped at the
	 * dashboard (see `dashboardConfidence`); this is the DECISION's worth.
	 */
	it('grades by the gates that DECIDED, not by the ones that held', () => {
		const evaluation = trailingBaselineGateEvaluator.evaluate(
			standaloneInput({
				own: arm({ sent: 10_000, deferred: 100 }),
				ownTrailingBaseline: null,
				ownSeeds: null,
			})
		);
		const decided = evaluation.perGate.filter((gate) => gate.status !== 'insufficient_data');
		expect(decided.map((gate) => gate.gate)).toEqual(['deferral']);
		expect(evaluation.measuredConfidence).toBe('high');
	});

	itEquipped('a healthy relay-backed cell measures at HIGH', () => {
		expect(referenceArmGateEvaluator.evaluate(healthyInput()).measuredConfidence).toBe('high');
	});

	it('a healthy standalone cell measures at MEDIUM — the proxy is the weakest link', () => {
		expect(trailingBaselineGateEvaluator.evaluate(standaloneInput()).measuredConfidence).toBe(
			'medium'
		);
	});

	itEquipped('a seed FAIL drags the reported confidence down to the tripwire’s level', () => {
		const evaluation = referenceArmGateEvaluator.evaluate(healthyInput({ ownSeeds: seeds(1, 19) }));
		expect(evaluation.failedGate).toBe('seed_placement');
		expect(evaluation.measuredConfidence).toBe('medium');
	});
});
