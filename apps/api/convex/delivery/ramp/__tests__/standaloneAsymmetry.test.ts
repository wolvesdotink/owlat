/**
 * THE ASYMMETRY (plan D14) — the key suite of P1-7.
 *
 * The standalone engagement gate is genuinely weak: a redesigned newsletter that
 * opens 20% worse is indistinguishable from a 20% placement loss. The plan's
 * answer is not to pretend otherwise but to make the weakness STRUCTURAL —
 *
 *     the low-confidence gate may cause a DECREASE,
 *     and may NEVER be the sole justification for an INCREASE.
 *
 * That rule is encoded on the VERDICT (`mayJustifyIncrease`), not left to a
 * caller's discipline, and this suite is what proves it: a `pass` that only the
 * weak gate produced must not reach the aggregate `pass` that lets the AIMD
 * controller raise a share, while the same gate's `fail` must still land in full.
 */

import { describe, expect, it } from 'vitest';
import { aggregateRampGates, trailingBaselineGateEvaluator } from '../gateEvaluation';
import type { RampGateId, RampGateResult } from '../gateTypes';
import { asTrailingEngagement, evaluateTrailingEngagementGate } from '../trailingBaselineGates';
import { NOW, arm, engagementInput, standaloneInput } from './gateFixtures';

/** A gate-4 verdict from the trailing comparison, healthy or collapsed. */
function trailingEngagement(recentOpened: number): RampGateResult {
	return evaluateTrailingEngagementGate(
		engagementInput({
			own: arm({ sent: 10_000, calibrationSent: 10_000, calibrationOpened: recentOpened }),
			ownRecent: arm({
				sent: 10_000,
				calibrationSent: 10_000,
				calibrationOpened: recentOpened,
			}),
			ownPriorBaseline: arm({ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 }),
		})
	);
}

/** A synthetic high-confidence answer, as a gate that is NOT the weak one. */
function strongResult(status: 'pass' | 'fail', gate: RampGateId = 'hard_bounce'): RampGateResult {
	const measurement = {
		ownRate: 0,
		referenceRate: null,
		thresholdRate: 0.02,
		toleranceValuePp: null,
		ownSample: 10_000,
		referenceSample: null,
		minSample: 200,
	} as const;
	return status === 'pass'
		? {
				gate,
				status: 'pass',
				reason: 'within_threshold',
				measurement,
				confidence: 'high',
				mayJustifyIncrease: true,
			}
		: {
				gate,
				status: 'fail',
				reason: 'absolute_threshold_breached',
				measurement,
				confidence: 'high',
				mayJustifyIncrease: true,
			};
}

describe('the weak gate carries its own asymmetry', () => {
	it('a PASS from the trailing engagement gate is low-confidence and may not justify an increase', () => {
		const passing = trailingEngagement(2_000);
		expect(passing.status).toBe('pass');
		expect(passing.confidence).toBe('low');
		expect(passing.mayJustifyIncrease).toBe(false);
	});

	it('a FAIL from the trailing engagement gate is still a full fail', () => {
		const failing = trailingEngagement(1_000);
		expect(failing.status).toBe('fail');
		expect(failing.confidence).toBe('low');
	});

	it('the asymmetry travels on the RESULT, not on a caller convention', () => {
		// Nothing about the call site distinguishes these two; the difference is
		// entirely in what the verdict says about itself.
		expect(trailingEngagement(2_000).mayJustifyIncrease).toBe(false);
		expect(strongResult('pass').mayJustifyIncrease).toBe(true);
	});
});

describe('the aggregator enforces it', () => {
	it('a window whose ONLY passing gate is the weak one HOLDS instead of passing', () => {
		const evaluation = aggregateRampGates({
			perGate: [trailingEngagement(2_000)],
			previousCleanStreak: 2,
			now: NOW,
		});
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.increaseEvidence).toBe(false);
		// HOLDS, both ways (plan D10): no advance toward K_CLEAN, and no reset.
		expect(evaluation.cleanStreak).toBe(2);
	});

	it('the same window with ONE strong pass alongside it is a clean window', () => {
		const evaluation = aggregateRampGates({
			perGate: [strongResult('pass'), trailingEngagement(2_000)],
			previousCleanStreak: 2,
			now: NOW,
		});
		expect(evaluation.verdict).toBe('pass');
		expect(evaluation.increaseEvidence).toBe(true);
		expect(evaluation.cleanStreak).toBe(3);
	});

	it('the weak gate can still RETREAT a cell on its own', () => {
		const evaluation = aggregateRampGates({
			perGate: [strongResult('pass'), trailingEngagement(1_000)],
			previousCleanStreak: 3,
			now: NOW,
		});
		expect(evaluation.verdict).toBe('fail');
		expect(evaluation.failedGate).toBe('engagement_ratio');
		expect(evaluation.cleanStreak).toBe(0);
	});

	it('a weak-only FAIL is a fail, where a weak-only PASS was only a hold', () => {
		const held = aggregateRampGates({
			perGate: [trailingEngagement(2_000)],
			previousCleanStreak: 0,
			now: NOW,
		});
		const failed = aggregateRampGates({
			perGate: [trailingEngagement(1_000)],
			previousCleanStreak: 0,
			now: NOW,
		});
		expect(held.verdict).toBe('insufficient_data');
		expect(failed.verdict).toBe('fail');
	});
});

describe('the standalone evaluator cannot be handed a strong engagement verdict', () => {
	it('re-grades whatever gate-4 result it is given down to the weak trailing signal', () => {
		const smuggled = strongResult('pass', 'engagement_ratio');
		const regraded = asTrailingEngagement(smuggled);
		expect(regraded.confidence).toBe('low');
		expect(regraded.mayJustifyIncrease).toBe(false);
		expect(regraded.status).toBe('pass');
	});

	it('re-REASONS it too: no standalone audit row names a relay that does not exist', () => {
		// Re-grading alone would leave the operator a `reference_*` reason (plan D12
		// keys the audit row and the admin notification off it) pointing at a
		// transport this deployment has never had.
		const measurement = {
			ownRate: 0.1,
			referenceRate: 0.2,
			thresholdRate: 0.19,
			toleranceValuePp: null,
			ownSample: 10_000,
			referenceSample: 10_000,
			minSample: 400,
		} as const;
		const smuggledFail = asTrailingEngagement({
			gate: 'engagement_ratio',
			status: 'fail',
			reason: 'reference_tolerance_breached',
			measurement,
			confidence: 'high',
			mayJustifyIncrease: true,
		});
		expect(smuggledFail.reason).toBe('trailing_baseline_breached');

		const holds = [
			['reference_evidence_stale', 'baseline_evidence_stale'],
			['reference_sample_below_floor', 'baseline_sample_below_floor'],
			['reference_rate_unmeasurable', 'baseline_rate_unmeasurable'],
			['reference_not_a_denominator', 'baseline_not_a_denominator'],
		] as const;
		for (const [smuggled, expected] of holds) {
			expect(
				asTrailingEngagement({
					gate: 'engagement_ratio',
					status: 'insufficient_data',
					reason: smuggled,
					measurement,
					confidence: 'high',
					mayJustifyIncrease: true,
				}).reason
			).toBe(expected);
		}

		// The OWN-arm vocabulary is about this deployment and survives untouched.
		expect(
			asTrailingEngagement({
				gate: 'engagement_ratio',
				status: 'insufficient_data',
				reason: 'own_sample_below_floor',
				measurement,
				confidence: 'high',
				mayJustifyIncrease: true,
			}).reason
		).toBe('own_sample_below_floor');
	});

	it('a healthy standalone cell still reaches PASS on its strong gates', () => {
		const evaluation = trailingBaselineGateEvaluator.evaluate(
			standaloneInput({ engagement: trailingEngagement(2_000), previousCleanStreak: 1 })
		);
		expect(evaluation.verdict).toBe('pass');
		expect(evaluation.increaseEvidence).toBe(true);
		expect(evaluation.cleanStreak).toBe(2);
	});

	it('a standalone cell with nothing but a smuggled strong engagement pass still holds', () => {
		// Every strong gate is unmeasurable (no trailing baseline, thin window), so
		// the ONLY thing that could produce a pass is the gate-4 result the caller
		// supplied — and it was re-graded on the way in.
		const evaluation = trailingBaselineGateEvaluator.evaluate({
			config: standaloneInput().config,
			own: arm({ sent: 10 }),
			reference: null,
			engagement: strongResult('pass', 'engagement_ratio'),
			previousCleanStreak: 2,
			now: NOW,
		});
		expect(evaluation.verdict).toBe('insufficient_data');
		expect(evaluation.increaseEvidence).toBe(false);
		expect(evaluation.cleanStreak).toBe(2);
	});
});
