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
} from './gates';
import type {
	RampGateAggregationInput,
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
	for (const result of perGate) {
		if (!contributes(result)) continue;
		// STRICTLY greater: the FIRST gate at the winning rank is the one named,
		// and gates arrive in the plan's numbering, so the earliest, most
		// fundamental problem is the one reported.
		if (winner === undefined || STATUS_RANK[result.status] > STATUS_RANK[winner.status]) {
			winner = result;
		}
	}

	// An evaluation nothing contributed to is evidence-free, and evidence-free is
	// exactly the state `pass` must not be reachable from.
	const verdict: RampVerdict = winner === undefined ? 'insufficient_data' : winner.status;

	const previous =
		Number.isFinite(previousCleanStreak) && previousCleanStreak > 0
			? Math.floor(previousCleanStreak)
			: 0;
	// A clean window extends the streak; a fail or a halt resets it; thin data
	// HOLDS it. The streak counts consecutive clean EVIDENCE, and a window we
	// could not measure is neither clean nor dirty.
	const cleanStreak =
		verdict === 'pass' ? previous + 1 : verdict === 'insufficient_data' ? previous : 0;
	const base = { cleanStreak, perGate, evaluatedAt: now };

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
