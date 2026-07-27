/**
 * Ramp controller — gate AGGREGATION (plan D3, D9, D10, D12, D17).
 *
 * Pure, like `gates.ts`: `now` is a parameter and nothing here reads a clock, a
 * database or the environment.
 *
 * PRECEDENCE, explicit and tested:
 *
 *     halt  >  fail  >  insufficient_data  >  pass
 *
 * `halt` outranks an ordinary fail because it is a hard stop rather than a
 * multiplicative decrease. `insufficient_data` outranks `pass` because the
 * controller must never increase on thin data — and, per plan D10, must never
 * DECREASE on it either, which is why holding is its own verdict rather than a
 * quiet failure.
 *
 * An OPTIONAL gate (`OPTIONAL_RAMP_GATES`) contributes only its `fail`/`halt`;
 * its `insufficient_data` is ignored. That is plan D2 in one line: no absent
 * external account may hold the ramp.
 *
 * NO EVIDENCE IS NOT A PASS. `pass` is the one verdict that lets the AIMD
 * controller raise a share, so it is never the default: an evaluation in which
 * NOTHING contributed — an empty gate list, or nothing but optional gates that
 * are all holding — returns `insufficient_data` and holds the streak where it
 * was. Never increase, and never decrease, on nothing (plan D10).
 *
 * WHAT THIS MODULE DOES NOT DECIDE. D17's corroboration rule is the
 * controller's (P3-2): a `fail` from a tripwire gate is flagged here through
 * `requiresCorroboration`, and P3-2 must confirm it against the deferral or
 * bounce results in `perGate` before halving a share. Acting on `verdict` alone
 * when `requiresCorroboration` is set is a defect in the caller.
 */

import { CORROBORATION_REQUIRED_RAMP_GATES, OPTIONAL_RAMP_GATES } from './gateConfig';
import {
	evaluateComplaintGate,
	evaluateDeferralGate,
	evaluateHardBounceGate,
	evaluateSeedPlacementGate,
	evaluateStandaloneSeedPlacementGate,
} from './gates';
import {
	weakestConfidence,
	type RampGateAggregationInput,
	type RampGateConfidence,
	type RampGateEvaluation,
	type RampGateEvaluationInput,
	type RampGateEvaluator,
	type RampGateId,
	type RampGateResult,
	type RampGateStatus,
	type RampVerdict,
} from './gateTypes';
import {
	asTrailingEngagement,
	evaluateStandaloneComplaintGate,
	evaluateStandaloneDeferralGate,
	evaluateTrailingHardBounceGate,
} from './trailingBaselineGates';

const STATUS_RANK: Readonly<Record<RampGateStatus, number>> = {
	halt: 3,
	fail: 2,
	insufficient_data: 1,
	pass: 0,
};

/**
 * Whether a gate's answer counts toward the aggregate verdict. Optionality is
 * read from the gate ID rather than from the result, so a caller-supplied
 * result cannot exempt itself from the ramp's holding logic.
 */
function contributes(result: RampGateResult): boolean {
	if (!OPTIONAL_RAMP_GATES.has(result.gate)) return true;
	return result.status === 'fail' || result.status === 'halt';
}

/**
 * Fold per-gate results into one verdict, in the order given. The first gate at
 * the winning rank is the one named: gates are evaluated in the plan's
 * numbering, so the earliest, most fundamental problem is the one reported.
 */
export function aggregateRampGates(args: RampGateAggregationInput): RampGateEvaluation {
	const { perGate, previousCleanStreak, now } = args;
	let contributed = false;
	let contributedVerdict: RampVerdict = 'pass';
	let failedGate: RampGateId | undefined;
	let rank = -1;
	let increaseEvidence = false;
	const confidences: RampGateConfidence[] = [];

	for (const result of perGate) {
		if (!contributes(result)) continue;
		contributed = true;
		confidences.push(result.confidence);
		if (result.status === 'pass' && result.mayJustifyIncrease) increaseEvidence = true;
		const resultRank = STATUS_RANK[result.status];
		if (resultRank > rank) {
			rank = resultRank;
			contributedVerdict = result.status;
			failedGate = result.status === 'pass' ? undefined : result.gate;
		}
	}

	// An evaluation nothing contributed to is evidence-free, and evidence-free is
	// exactly the state `pass` must not be reachable from.
	const contributedOrHold: RampVerdict = contributed ? contributedVerdict : 'insufficient_data';

	// THE ASYMMETRY (plan D14). A window in which everything that passed was a
	// low-confidence gate is not a clean window — it is a window with no evidence
	// for going UP, and it holds. The same gate's FAIL is untouched by this: a weak
	// signal is allowed to retreat a share, it is just never allowed to advance one.
	const verdict: RampVerdict =
		contributedOrHold === 'pass' && !increaseEvidence ? 'insufficient_data' : contributedOrHold;

	const previous =
		Number.isFinite(previousCleanStreak) && previousCleanStreak > 0
			? Math.floor(previousCleanStreak)
			: 0;
	// A clean window extends the streak; a fail or a halt resets it; thin data
	// HOLDS it. The streak counts consecutive clean EVIDENCE, and a window we
	// could not measure is neither clean nor dirty.
	const cleanStreak =
		verdict === 'pass' ? previous + 1 : verdict === 'insufficient_data' ? previous : 0;

	const requiresCorroboration =
		(verdict === 'fail' || verdict === 'halt') &&
		failedGate !== undefined &&
		CORROBORATION_REQUIRED_RAMP_GATES.has(failedGate);

	return {
		verdict,
		...(failedGate === undefined ? {} : { failedGate }),
		requiresCorroboration,
		cleanStreak,
		perGate,
		// No contribution means no measurement, and "we measured nothing" is the
		// lowest confidence there is — never the `high` an empty list would fold to.
		confidence: contributed ? weakestConfidence(confidences) : 'low',
		increaseEvidence,
		evaluatedAt: now,
	};
}

/**
 * The concurrent, two-armed evaluator (plan D3's first implementation): a
 * reference transport is configured, so every gate can compare the two arms
 * over the same window. P1-7 adds the trailing-baseline twin behind the same
 * interface — two implementations, not N. The CALLER picks which one it wants;
 * there is deliberately no delegating `evaluateGates` wrapper that would hide
 * which implementation ran.
 */
export const referenceArmGateEvaluator: RampGateEvaluator = {
	kind: 'reference_arm',
	evaluate(input: RampGateEvaluationInput): RampGateEvaluation {
		const perGate: RampGateResult[] = [
			evaluateHardBounceGate(input),
			evaluateDeferralGate(input),
			evaluateComplaintGate(input),
		];
		// Gate 4 (engagement ratio) is computed elsewhere; absent means "not
		// measured this window", which contributes nothing rather than holding.
		if (input.engagement) perGate.push(input.engagement);
		perGate.push(evaluateSeedPlacementGate(input));
		return aggregateRampGates({
			perGate,
			previousCleanStreak: input.previousCleanStreak,
			now: input.now,
		});
	},
};

/**
 * The STANDALONE evaluator (plan D2, D3, D14): no reference transport, and no
 * apology for it.
 *
 * SAME INTERFACE, SAME PRECEDENCE, SAME AGGREGATOR. The five gates are evaluated
 * in the plan's numbering and folded by `aggregateRampGates` exactly as the
 * reference-arm ones are, so halt-over-fail-over-hold-over-pass, the optional-gate
 * rule, the clean-streak rule and the corroboration flag are shared rather than
 * reimplemented. What differs is entirely inside the specs: which second series
 * each gate compares against, in which unit, and what its verdict is worth.
 *
 * TWO THINGS THIS EVALUATOR ENFORCES AT THE BOUNDARY, both of them because the
 * degraded path is the one nobody runs by hand:
 *
 *   1. `input.reference` IS IGNORED. Not asserted against, not thrown on —
 *      ignored. Every gate here reads the cell's own history, so a caller that
 *      wires a reference arm into this evaluator gets standalone behaviour rather
 *      than a silent hybrid nobody designed.
 *   2. The pre-computed gate-4 result is RE-GRADED to the weak trailing signal
 *      (`asTrailingEngagement`), so the concurrent ratio's high-confidence,
 *      increase-justifying verdict cannot be smuggled into a deployment that has
 *      no second arm to have measured it with.
 */
export const trailingBaselineGateEvaluator: RampGateEvaluator = {
	kind: 'trailing_baseline',
	evaluate(input: RampGateEvaluationInput): RampGateEvaluation {
		const perGate: RampGateResult[] = [
			evaluateTrailingHardBounceGate(input),
			evaluateStandaloneDeferralGate(input),
			evaluateStandaloneComplaintGate(input),
		];
		// Gate 4, exactly as the reference-arm evaluator treats it: absent means
		// "not measured this window", which contributes nothing rather than holding.
		// Holding here instead would freeze every standalone cell that has not yet
		// accumulated 2000 calibration sends — turning an ABSENT weak signal into a
		// blocker, which is the one thing plan D2 forbids it from being.
		if (input.engagement) perGate.push(asTrailingEngagement(input.engagement));
		perGate.push(evaluateStandaloneSeedPlacementGate(input));
		return aggregateRampGates({
			perGate,
			previousCleanStreak: input.previousCleanStreak,
			now: input.now,
		});
	},
};
