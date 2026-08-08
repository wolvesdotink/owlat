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
import { weakestConfidence } from './gateGrades';
import { collectRampGateSignals, type RampArm } from '../signals/rampGateSources';
import type {
	RampGateAggregationInput,
	RampGateConfidence,
	RampGateEvaluation,
	RampGateEvaluationInput,
	RampGateEvaluator,
	RampGateResult,
	RampGateStatus,
	RampVerdict,
} from './gateTypes';

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
	// The WINNING RESULT is carried whole rather than shredded into a rank, a
	// verdict and a gate id: the verdict and the gate that produced it are one
	// fact, and keeping them together is what lets the returned union promise a
	// named gate on every `fail`/`halt` without a re-derivation the type system
	// would have to be talked into believing.
	let winner: RampGateResult | undefined;
	let increaseEvidence = false;
	const confidences: RampGateConfidence[] = [];

	for (const result of perGate) {
		if (!contributes(result)) continue;
		// A GATE THAT MEASURED NOTHING HAS NO CONFIDENCE TO CONTRIBUTE (plan D14).
		// `measuredConfidence` grades how much a VERDICT is worth, and a hold is not a
		// verdict — folding a holding gate's grade in would let a column of "not
		// enough data yet" fold to `high` and tell the operator the cell is
		// well-measured precisely when nothing measured it. Holds still contribute
		// to the VERDICT above; they contribute nothing to the grade.
		if (result.status !== 'insufficient_data') confidences.push(result.confidence);
		if (result.status === 'pass' && result.mayJustifyIncrease) increaseEvidence = true;
		// STRICTLY greater: the FIRST gate at the winning rank is the one named,
		// and gates arrive in the plan's numbering, so the earliest, most
		// fundamental problem is the one reported.
		if (winner === undefined || STATUS_RANK[result.status] > STATUS_RANK[winner.status]) {
			winner = result;
		}
	}

	// An evaluation nothing contributed to is evidence-free, and evidence-free is
	// exactly the state `pass` must not be reachable from.
	const contributedOrHold: RampVerdict = winner === undefined ? 'insufficient_data' : winner.status;

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
	const base = {
		cleanStreak,
		perGate,
		// No DECIDED gate means no measurement, and "we measured nothing" is the
		// lowest confidence there is — never the `high` an empty list would fold to.
		measuredConfidence: confidences.length > 0 ? weakestConfidence(confidences) : 'low',
		increaseEvidence,
		evaluatedAt: now,
	} as const;

	// A BREACH IS NAMED, always: the branch is taken off the winning RESULT, so
	// the gate that produced the verdict travels with it and no re-derivation is
	// needed to satisfy the union.
	if (winner !== undefined && (winner.status === 'fail' || winner.status === 'halt')) {
		return {
			...base,
			verdict: winner.status,
			failedGate: winner.gate,
			requiresCorroboration: CORROBORATION_REQUIRED_RAMP_GATES.has(winner.gate),
		};
	}
	return {
		...base,
		verdict: verdict === 'pass' ? 'pass' : 'insufficient_data',
		...(winner === undefined || winner.status === 'pass' ? {} : { failedGate: winner.gate }),
		requiresCorroboration: false,
	};
}

/**
 * ONE EVALUATION BODY, ASKED PER ARM (plan D9).
 *
 * Which measurements exist, in which order they fold, and which of them an arm
 * evaluates are declared once in `../signals/rampGateSources` — so this module
 * no longer names gate modules, and a sixth measurement is registered rather
 * than remembered twice. What is left here is the part that is genuinely shared:
 * the fold.
 *
 * THE ARM IS NAMED ONCE. A factory rather than two object literals, because an
 * evaluator that declared `kind` and then passed the arm again would be one fact
 * written twice: a third arm copy-pasted from the second, with `kind` changed
 * and the second argument forgotten, would report itself as the new arm while
 * folding the old one's evaluators — and both spellings typecheck.
 */
function armGateEvaluator(kind: RampArm): RampGateEvaluator {
	return {
		kind,
		evaluate(input: RampGateEvaluationInput): RampGateEvaluation {
			return aggregateRampGates({
				perGate: collectRampGateSignals(kind, input),
				previousCleanStreak: input.previousCleanStreak,
				now: input.now,
			});
		},
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
export const referenceArmGateEvaluator: RampGateEvaluator = armGateEvaluator('reference_arm');

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
 *   2. The pre-computed gate-4 result is RE-GRADED to the weak trailing signal,
 *      so the concurrent ratio's high-confidence, increase-justifying verdict
 *      cannot be smuggled into a deployment that has no second arm to have
 *      measured it with.
 *
 * BOTH RULES ARE THE REGISTRY'S, not this constant's: each source declares which
 * evaluator this arm runs, so the standalone arm reads the cell's own history
 * because that is the only evaluator it has — not because a branch here says so.
 */
export const trailingBaselineGateEvaluator: RampGateEvaluator =
	armGateEvaluator('trailing_baseline');
