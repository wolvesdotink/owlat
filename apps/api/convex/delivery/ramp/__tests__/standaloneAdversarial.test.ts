/**
 * HOSTILE AND DEGENERATE INPUTS, THROUGH THE STANDALONE IMPLEMENTATION.
 *
 * The twin of `gates.adversarial.test.ts`, and it exists as a second file for a
 * reason that is the whole point of this piece: that suite builds every fixture
 * with a reference arm, so it is `describeEquipped` and the standalone leg of the
 * `ramp-gate-matrix` runs no adversarial coverage at all. The trailing-baseline
 * gates would then be protected only by the fact that `evaluateCeilingGate` is
 * currently ONE shared cascade — and a change to the poisoned-rate or clock-skew
 * rule that is right for the concurrent arm and wrong for the trailing one would
 * fail neither leg. That coupling is exactly what the degraded path must not be
 * allowed to depend on (plan D3).
 *
 * NOTHING HERE IS WRAPPED IN `describeEquipped`: every fixture is built from
 * `standaloneInput` / `engagementInput` with no reference arm and no reference
 * seed sweep, so the file runs identically in BOTH legs.
 *
 * The contract under attack is the same absolute one: nothing may throw, and
 * nothing may return `pass`. A crafted snapshot that talks the controller into a
 * `pass` is the threat model; a zero-volume cell, a poisoned bucket, a
 * clock-skewed MTA and a future-dated trailing window must all land on
 * `insufficient_data` or `fail`.
 */

import { describe, expect, it } from 'vitest';
import type { TransportOutcomeSummary } from '../../../analytics/transportOutcomeSummary';
import { trailingBaselineGateEvaluator } from '../gateEvaluation';
import type { RampGateEvaluationInput, RampGateResult } from '../gateTypes';
import {
	evaluateSmtpBlockMessages,
	evaluateStandaloneComplaintGate,
	evaluateStandaloneDeferralGate,
	evaluateStandaloneSeedPlacementGate,
	evaluateTrailingEngagementGate,
	evaluateTrailingHardBounceGate,
} from '../trailingBaselineGates';
import {
	BEYOND_SKEW,
	POISON_RATE_VALUES,
	arm,
	blocks,
	engagementInput,
	poisonedRates,
	seeds,
	standaloneInput,
} from './gateFixtures';

/**
 * The hostile-rate catalogue, BUILT FROM THE SHARED TABLE in `gateFixtures` — the
 * same table `gates.adversarial.test.ts` builds its own from, so a poison shape
 * added there reaches both implementations.
 */
const POISONS: ReadonlyArray<readonly [string, Partial<TransportOutcomeSummary>]> =
	POISON_RATE_VALUES.map(([label, value]) => [label, poisonedRates(value)] as const);

const AMPLE = { sent: 10_000, hardBounced: 100, deferred: 100, complained: 5, unsubscribed: 30 };
const AMPLE_BASELINE = {
	sent: 40_000,
	hardBounced: 400,
	deferred: 400,
	complained: 20,
	unsubscribed: 120,
};

type StandaloneGate = (built: RampGateEvaluationInput) => RampGateResult;

/**
 * Both complaint SPECS, not just the one the default fixture selects: the CFBL
 * spec and the unsubscribe proxy take different branches of the cascade (one is
 * absolute-only, the other relative-only) and a poison that only reaches one of
 * them is a poison half-tested.
 */
const STANDALONE_GATES: ReadonlyArray<readonly [string, StandaloneGate]> = [
	['gate 1 — trailing hard bounce', evaluateTrailingHardBounceGate],
	['gate 2 — standalone deferral', evaluateStandaloneDeferralGate],
	[
		'gate 3 — CFBL complaint',
		(built) => evaluateStandaloneComplaintGate({ ...built, hasComplaintFeedback: true }),
	],
	[
		'gate 3 — unsubscribe proxy',
		(built) => evaluateStandaloneComplaintGate({ ...built, hasComplaintFeedback: false }),
	],
	['gate 5 — self-hosted seeds', evaluateStandaloneSeedPlacementGate],
];

/**
 * THE ASSERTION, once: no standalone gate passes, the evaluator does not pass,
 * and — the property the AIMD controller actually reads — the evaluation carries
 * NO evidence for an increase. Every fixture below strips the seed sweep and the
 * engagement result so that the only thing left that could contribute evidence is
 * the poisoned data itself.
 */
function expectNoPassAndNoIncrease(built: RampGateEvaluationInput): void {
	for (const [name, gate] of STANDALONE_GATES) {
		const result = gate(built);
		expect(result.status, `${name} must not pass`).not.toBe('pass');
	}
	const evaluation = trailingBaselineGateEvaluator.evaluate(built);
	expect(evaluation.verdict).not.toBe('pass');
	expect(evaluation.increaseEvidence).toBe(false);
}

/**
 * The weaker assertion, for a fixture that corrupts only the TRAILING BASELINE.
 *
 * The own arm is deliberately left healthy there, so the gates that read no
 * baseline (deferral, and the absolute-only CFBL complaint spec) are SUPPOSED to
 * keep deciding — that is plan D2's rule that a missing or unusable second series
 * lowers confidence and slows the ramp rather than stopping the deployment. What
 * must hold is that the two gates whose comparative half just evaporated do not
 * pass on half a check, and that the cell as a whole cannot be advanced.
 */
function expectBaselineDependentGatesHold(built: RampGateEvaluationInput): void {
	expect(evaluateTrailingHardBounceGate(built).status).toBe('insufficient_data');
	expect(evaluateStandaloneComplaintGate({ ...built, hasComplaintFeedback: false }).status).toBe(
		'insufficient_data'
	);
	expect(trailingBaselineGateEvaluator.evaluate(built).verdict).not.toBe('pass');
}

/** A standalone cell with every optional external-ish input removed. */
function bare(overrides: Partial<RampGateEvaluationInput> = {}): RampGateEvaluationInput {
	return standaloneInput({ ownSeeds: null, smtpBlocks: null, engagement: null, ...overrides });
}

describe('standalone — degenerate volumes', () => {
	it('a zero-volume cell (0/0 everywhere) holds and never passes', () => {
		expectNoPassAndNoIncrease(
			bare({
				own: arm({ sent: 0 }),
				ownTrailingBaseline: arm({ sent: 0 }),
				ownSeeds: seeds(0, 0),
			})
		);
	});

	it('sends with no observation at all holds and never passes', () => {
		expectNoPassAndNoIncrease(
			bare({
				own: arm({ ...AMPLE, lastRecordedAt: null }),
				ownTrailingBaseline: arm({ ...AMPLE_BASELINE, lastRecordedAt: null }),
			})
		);
	});

	it('negative counters hold and never pass', () => {
		expectNoPassAndNoIncrease(
			bare({
				own: arm({ sent: -10_000, hardBounced: -5, deferred: -5, complained: -5 }),
				ownTrailingBaseline: arm({ sent: -40_000, hardBounced: -5, unsubscribed: -5 }),
				ownSeeds: seeds(-10, -10, -10),
			})
		);
	});
});

describe('standalone — poisoned rates', () => {
	for (const [label, rates] of POISONS) {
		it(`${label} rates on the OWN arm hold and never pass`, () => {
			expectNoPassAndNoIncrease(
				bare({
					own: arm(AMPLE, rates),
					ownTrailingBaseline: arm(AMPLE_BASELINE),
				})
			);
		});

		it(`${label} rates on the TRAILING BASELINE hold the gates that read it`, () => {
			// The own arm is ample, fresh and healthy here, so a hold can only be
			// explained by the baseline — which is the coupling this file exists to
			// pin: the standalone gates are the only ones that read it.
			expectBaselineDependentGatesHold(
				bare({ own: arm(AMPLE), ownTrailingBaseline: arm(AMPLE_BASELINE, rates) })
			);
		});

		it(`${label} rates on BOTH arms hold and never pass`, () => {
			expectNoPassAndNoIncrease(
				bare({ own: arm(AMPLE, rates), ownTrailingBaseline: arm(AMPLE_BASELINE, rates) })
			);
		});
	}

	it('a poisoned OWN rate is reported as unmeasurable, not as a thin window', () => {
		// The reason code is what the audit row and the admin notification render
		// from (plan D12); a poisoned bucket and a small one need different fixes.
		const built = bare({ own: arm(AMPLE, poisonedRates(Number.NaN)) });
		expect(evaluateTrailingHardBounceGate(built)).toMatchObject({
			status: 'insufficient_data',
			reason: 'own_rate_unmeasurable',
		});
	});

	it('a poisoned BASELINE speaks the baseline vocabulary, never the reference one', () => {
		// An operator with no relay must never be sent looking for one.
		const built = bare({
			own: arm(AMPLE),
			ownTrailingBaseline: arm(AMPLE_BASELINE, poisonedRates(Number.NaN)),
		});
		expect(evaluateTrailingHardBounceGate(built)).toMatchObject({
			status: 'insufficient_data',
			reason: 'baseline_rate_unmeasurable',
		});
	});

	it('a poisoned SMTP block window cannot manufacture a halt or a pass', () => {
		const built = bare({
			own: arm(AMPLE),
			// More blocked than observed is an impossible row, and it must not be
			// clamped into the one verdict in this module that halts a cell.
			smtpBlocks: blocks(9_000, 1_000),
		});
		expect(evaluateSmtpBlockMessages(built)).toBeNull();
		expect(evaluateStandaloneDeferralGate(built).status).not.toBe('halt');
	});
});

describe('standalone — clock skew', () => {
	it('a future-dated OWN arm holds and never passes', () => {
		expectNoPassAndNoIncrease(
			bare({
				own: arm({ ...AMPLE, lastRecordedAt: BEYOND_SKEW }),
				ownTrailingBaseline: arm(AMPLE_BASELINE),
			})
		);
	});

	it('a future-dated TRAILING BASELINE holds the gates that read it', () => {
		expectBaselineDependentGatesHold(
			bare({
				own: arm(AMPLE),
				ownTrailingBaseline: arm({ ...AMPLE_BASELINE, lastRecordedAt: BEYOND_SKEW }),
			})
		);
	});

	it('a future-dated block window cannot halt', () => {
		const built = bare({
			own: arm(AMPLE),
			smtpBlocks: blocks(900, 1_000, { observedAt: BEYOND_SKEW }),
		});
		expect(evaluateSmtpBlockMessages(built)).toBeNull();
	});

	it('a NaN evaluation clock holds rather than deciding', () => {
		expectNoPassAndNoIncrease(bare({ own: arm(AMPLE), now: Number.NaN }));
	});
});

describe('standalone — gate 4 under attack', () => {
	function trailingEngagement(
		ownOverrides: Partial<TransportOutcomeSummary>,
		baselineOverrides: Partial<TransportOutcomeSummary> = {}
	): RampGateResult {
		const own = arm({ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 });
		return evaluateTrailingEngagementGate(
			engagementInput({
				own,
				ownRecent: arm(
					{ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 },
					ownOverrides
				),
				ownPriorBaseline: arm(
					{ sent: 10_000, calibrationSent: 10_000, calibrationOpened: 2_000 },
					baselineOverrides
				),
			})
		);
	}

	const engagementPoisons: ReadonlyArray<readonly [string, number]> = [
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['negative', -1],
		// Above 1 is corruption for an inverted-polarity gate: clamping it would
		// manufacture the one verdict the controller is allowed to raise a share on.
		['above 1', 4],
	];

	for (const [label, value] of engagementPoisons) {
		it(`holds on ${label} recent engagement`, () => {
			const result = trailingEngagement({ calibrationOpenRate: value });
			expect(result.status).toBe('insufficient_data');
			expect(result.mayJustifyIncrease).toBe(false);
		});

		it(`holds on ${label} baseline engagement`, () => {
			const result = trailingEngagement({}, { calibrationOpenRate: value });
			expect(result.status).toBe('insufficient_data');
			expect(result.mayJustifyIncrease).toBe(false);
		});
	}

	it('holds on a zero-volume engagement window', () => {
		const result = trailingEngagement({ sent: 0, calibrationSent: 0, calibrationOpenRate: 0 });
		expect(result.status).toBe('insufficient_data');
	});

	it('holds on a future-dated baseline rather than trusting it', () => {
		const result = trailingEngagement({}, { lastRecordedAt: BEYOND_SKEW });
		expect(result).toMatchObject({
			status: 'insufficient_data',
			reason: 'baseline_evidence_stale',
		});
	});

	it('a zero baseline is NOT a denominator, and says so', () => {
		const result = trailingEngagement({}, { calibrationOpenRate: 0 });
		expect(result).toMatchObject({
			status: 'insufficient_data',
			reason: 'baseline_not_a_denominator',
		});
	});

	it('NO trailing-baseline verdict may ever justify an increase (plan D14)', () => {
		expect(trailingEngagement({}).mayJustifyIncrease).toBe(false);
	});
});
