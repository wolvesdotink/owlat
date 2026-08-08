/**
 * THE TRAILING-BASELINE GATES — the standalone implementation (plan D2, D3, D14).
 *
 * The second and FINAL implementation of the gate interface, for a deployment
 * with no reference transport. It exists because "no ESP account" is a
 * FIRST-CLASS CONFIGURATION and not a degraded one (plan D2), and this module is
 * what makes that claim true at the measurement layer rather than only in the
 * marketing copy: every gate still returns a verdict, nothing errors, nothing
 * nags, and the ramp still moves — on weaker evidence, at a slower pace, and
 * SAYING SO.
 *
 * THE SUBSTITUTIONS, straight from the plan's "gates, degraded honestly" table:
 *
 *   1 HARD BOUNCE  absolute <=2% AND <=1.5x the cell's own 30-day trailing rate.
 *                  Confidence HIGH — bounce processing is entirely self-hosted
 *                  (VERP + DSN parsing) and never depended on a third party.
 *   2 DEFERRAL/4xx UNCHANGED, and PROMOTED TO PRIMARY. Confidence HIGH.
 *                  The plan also specifies per-ISP BLOCK-MESSAGE detection from
 *                  the shipped SMTP classifier as a HARD STOP beside it — see
 *                  `evaluateSmtpBlockMessages`, which OUTRANKS the rate: what a
 *                  receiver says it is refusing does not get better by sending
 *                  less, so it halts rather than decreasing (issue #501). A cell
 *                  with no classified response in the window falls through to
 *                  the rate alone.
 *   3 COMPLAINT    CFBL reports where a feedback loop exists; OTHERWISE the
 *                  one-click UNSUBSCRIBE rate at or above 3x the cell's trailing
 *                  baseline, treated as a complaint-equivalent breach.
 *                  Confidence HIGH with a feedback loop, MEDIUM on the proxy —
 *                  and the verdict says which.
 *   4 ENGAGEMENT   the cell's own 30-day trailing window, floor relaxed to 0.85,
 *                  window widened to 7 days, minimum 2000 calibration sends.
 *                  Confidence LOW, and it may NEVER justify an INCREASE.
 *   5 PLACEMENT    self-hosted seed mailboxes, absolute floor only, promoted from
 *                  optional to RECOMMENDED. Confidence MEDIUM (a tripwire, D17).
 *                  Its cascade is shared with the reference-arm gate and lives in
 *                  `seedGate.ts`; the entry point is RE-EXPORTED below so all five
 *                  standalone gates are reachable from this one module.
 *
 * WHAT IS NOT HERE. No cascade. Every gate below is the SAME evaluator the
 * reference-arm implementation uses, handed a different SPEC — a different second
 * series, a different unit, a different grade. That is deliberate and it is the
 * plan's defence against the degraded path rotting: a fix to the freshness rule,
 * the thin-sample rule or the poisoned-rate rule lands in both implementations at
 * once because there is only one of each.
 *
 * THE COLD START, NAMED (plan D10), because the population this module exists
 * for is a FRESH INSTALL and this is what it sees on day one. With no
 * `ownTrailingBaseline` — or one below the sample floors — gate 1 holds on
 * `evidence_absent` / `baseline_sample_below_floor`, and the gate-3 unsubscribe
 * proxy holds for the same reason. Holds outrank passes in `aggregateRampGates`,
 * so a standalone cell CANNOT REACH `pass` until its trailing window clears the
 * hard-bounce (200) and complaint (1000) floors, and the ramp sits at the
 * stream's initial `s` for that long.
 *
 * THAT IS CORRECT, NOT A DEFECT. D10 says thin data HOLDS: it never increases on
 * it and never decreases on it either, so the cost of the cold start is time, not
 * risk. What UNFREEZES it is volume — and P3-2's cron should hand this module a
 * PARTIAL-HISTORY trailing summary as soon as the window clears those floors,
 * rather than passing `null` until some notional thirty days have elapsed. The
 * gates already judge the summary they are given on its own sample and freshness;
 * withholding a usable one only lengthens the freeze.
 *
 * PURE (plan D15): `now` is a parameter, nothing reads a clock, a database or the
 * environment.
 */

import { SMTP_BLOCK_CATEGORIES, type SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';
import { evaluateCeilingGate, type CeilingGateSpec } from './ceilingGate';
import { ENGAGEMENT_GATE_THRESHOLDS } from './engagementConfig';
import {
	evaluateEngagementComparison,
	type EngagementComparisonSpec,
	type EngagementGateInput,
} from './engagementGate';
import { evaluateDeferralGate } from './gates';
import { evaluateStandaloneSeedPlacementGate } from './seedGate';
import { asBaselineHoldReason, evidenceFreshness, safeRate } from './gateEvidence';
import { DIRECT_MEASUREMENT, PROXY_MEASUREMENT, WEAK_TRAILING_SIGNAL } from './gateGrades';
import { oneArmedMeasurement } from './gateMeasurement';
import type { RampGateEvaluationInput, RampGateResult, SmtpBlockObservation } from './gateTypes';
import { safeOutcomeCount } from '../../analytics/transportOutcomeSummary';

// ============================ gate 1 — hard bounce ==========================

/**
 * The absolute 2% ceiling is UNCHANGED — a 2% hard-bounce rate is not more
 * acceptable because nobody is watching — and the comparative half swaps the
 * concurrent relay arm for the cell's own 30-day trailing window at a 1.5x
 * multiple.
 *
 * A MULTIPLE and not a percentage-point tolerance, because the two comparisons
 * are not the same shape. The relay arm is the other half of the SAME send, so an
 * additive allowance of half a point is meaningful against it. The trailing
 * window is a different month with a different list; what matters there is not
 * "half a point worse" but "half again as bad as we were", which is a ratio.
 */
export const TRAILING_HARD_BOUNCE_SPEC: CeilingGateSpec = {
	gate: 'hard_bounce',
	rateOf: (summary) => summary.hardBounceRate,
	thresholdOf: (thresholds) => thresholds.hardBounceMax,
	floorOf: (floors) => floors.hardBounce,
	secondSeries: {
		of: (input) => input.ownTrailingBaseline ?? null,
		arm: 'baseline',
		maxAgeOf: (thresholds) => thresholds.maxBaselineAgeMs,
		floorOf: (floors) => floors.hardBounce,
		// "AT MOST 1.5x": exactly 1.5x is inside the allowance.
		comparison: {
			kind: 'multiple',
			of: (t) => t.hardBounceTrailingMultiple,
			boundary: 'inclusive_pass',
			failReason: 'trailing_baseline_breached',
		},
	},
	grade: DIRECT_MEASUREMENT,
};

/** Gate 1, standalone: own arm <= 2% AND <= 1.5x its own 30-day trailing rate. */
export function evaluateTrailingHardBounceGate(input: RampGateEvaluationInput): RampGateResult {
	return evaluateCeilingGate(TRAILING_HARD_BOUNCE_SPEC, input);
}

// ============================= gate 3 — complaint ===========================

/**
 * WITH a feedback loop: the shipped absolute complaint ceiling, and nothing else.
 *
 * Absolute-only on purpose. A complaint rate is already an absolute number with a
 * hard industry meaning (0.1% is the line every major receiver publishes), so it
 * needs no second series to be interpretable — and requiring one would make a
 * young standalone cell hold this gate for thirty days before it could say
 * anything at all.
 */
export const CFBL_COMPLAINT_SPEC: CeilingGateSpec = {
	gate: 'complaint',
	rateOf: (summary) => summary.complaintRate,
	thresholdOf: (thresholds) => thresholds.complaintMax,
	floorOf: (floors) => floors.complaint,
	secondSeries: null,
	grade: DIRECT_MEASUREMENT,
};

/**
 * WITHOUT one: the one-click UNSUBSCRIBE rate against the cell's own trailing
 * unsubscribe rate, at 3x.
 *
 * NO ABSOLUTE CEILING, and this is the substitution's one subtlety. Unsubscribe
 * rates run an order of magnitude above complaint rates — a healthy list
 * unsubscribes at a few tenths of a percent — so applying the 0.1% complaint
 * ceiling to them would fail every cell that has ever sent mail. What carries
 * signal is not the level but the MOVE: a tripling against the cell's own recent
 * history is people reaching for the unsubscribe link in numbers they were not
 * reaching for it in last month, which is what a spam-folder placement looks like
 * from this side of the wire.
 *
 * BOTH SIDES ARE THE SAME RATE, so the denominators match. `unsubscribeRate` is
 * denominated on `delivered` while `complaintRate` is denominated on `sent`
 * (see `TransportOutcomeSummary`), and comparing one against the other would be a
 * unit error dressed up as a threshold. This gate never does: it compares
 * unsubscribes against unsubscribes.
 *
 * MEDIUM confidence, and the verdict says so. It is a proxy, it is labelled as
 * one, and the UI renders the label (plan D14).
 */
export const UNSUBSCRIBE_PROXY_SPEC: CeilingGateSpec = {
	gate: 'complaint',
	rateOf: (summary) => summary.unsubscribeRate,
	thresholdOf: () => null,
	floorOf: (floors) => floors.complaint,
	secondSeries: {
		of: (input) => input.ownTrailingBaseline ?? null,
		arm: 'baseline',
		maxAgeOf: (thresholds) => thresholds.maxBaselineAgeMs,
		floorOf: (floors) => floors.complaint,
		// "AT OR ABOVE 3x is a complaint-equivalent breach": exactly 3.0x FAILS.
		comparison: {
			kind: 'multiple',
			of: (t) => t.unsubscribeProxyMultiple,
			boundary: 'inclusive_fail',
			failReason: 'trailing_baseline_breached',
		},
	},
	grade: PROXY_MEASUREMENT,
};

/**
 * Gate 3, standalone. Which spec runs is a property of the DEPLOYMENT (does a
 * feedback loop deliver reports for this sending identity?), not of the window,
 * so it is selected here rather than inside the cascade.
 *
 * Absence of a feedback loop lowers the confidence of the answer and changes
 * which series it is measured against. It does not block, error, warn or nag
 * (plan D2).
 */
export function evaluateStandaloneComplaintGate(input: RampGateEvaluationInput): RampGateResult {
	return evaluateCeilingGate(
		input.hasComplaintFeedback === true ? CFBL_COMPLAINT_SPEC : UNSUBSCRIBE_PROXY_SPEC,
		input
	);
}

// ================== gate 2 — deferral, plus block messages ==================

/**
 * THE ONE DERIVATION of "what did the receivers refuse, and how much of it".
 *
 * The COUNT and the NAMES come out of the SAME map here, so they cannot describe
 * different rows: the numerator is the sum over the keys that are in
 * `SMTP_BLOCK_CATEGORIES`, and the named categories are exactly those keys with a
 * positive count. Rate pressure in the map is carried, counted by nobody, and
 * never reaches the numerator.
 *
 * Exported because the admin notification (plan D12) names the categories and the
 * gate applies the rate: two readers, one derivation, no second opinion.
 */
export function summarizeSmtpBlocks(observation: SmtpBlockObservation): {
	readonly blocked: number;
	readonly categories: readonly SmtpFailureCategory[];
} {
	let blocked = 0;
	const categories: SmtpFailureCategory[] = [];
	for (const category of SMTP_BLOCK_CATEGORIES) {
		const count = safeOutcomeCount(observation.blockedByCategory[category]);
		if (count <= 0) continue;
		blocked += count;
		categories.push(category);
	}
	return { blocked, categories };
}

/**
 * The share of classified responses that were BLOCK messages, or `null` when the
 * row cannot express one.
 *
 * MORE BLOCKS THAN RESPONSES IS NOT A 100% BLOCK RATE — it is a producer bug, and
 * `safeRate`'s clamp would turn it into the highest possible reading of the one
 * signal in this module that HALTS a cell outright. `safeEngagementRate` exists a
 * module away for exactly this reason: a clamp is the safe answer when it can
 * only lose a verdict, and the wrong answer when it manufactures one. So the
 * impossible row is treated as unmeasurable and the deferral rate behind it
 * decides on its own.
 */
function blockRate(observation: SmtpBlockObservation): number | null {
	const observed = safeOutcomeCount(observation.observed);
	const blocked = summarizeSmtpBlocks(observation).blocked;
	if (observed <= 0 || blocked > observed) return null;
	return safeRate(blocked / observed);
}

/**
 * Gate 2, standalone: THE PRIMARY FAST SIGNAL.
 *
 * Unchanged in its arithmetic — the 4xx ceiling and the halt line are the shipped
 * ones, because they never depended on a third party in the first place — and
 * extended with what the responses SAY rather than only how many there were.
 * `input.smtpBlocks` is supplied by both production readers (issue #501); a cell
 * whose window carries no classified response falls through to the rate alone.
 *
 * A BLOCK IS NOT A DEFERRAL RATE. Throttling and blocking both arrive as 4xx and
 * both land in the deferral counter, but they mean opposite things about what to
 * do next: throttling gets better if we slow down, and a receiver telling us our
 * content is spam or our IP is not one it takes mail from does not get better if
 * we send at all. So the block detector outranks the rate check and produces a
 * HALT — the same hard stop the deferral halt line produces, named differently so
 * the admin notification (plan D12) can tell the operator which thing happened.
 *
 * The CLASSIFICATION is the MTA's (`classifySmtpResponse`) and the category names
 * are the shared vocabulary in `@owlat/shared/smtpBlockCategories`. This side only
 * counts — and counts against a minimum sample and a freshness rule like every
 * other gate, because a hard stop that can fire on one stale response is a hard
 * stop that will fire on one stale response.
 */
export function evaluateStandaloneDeferralGate(input: RampGateEvaluationInput): RampGateResult {
	const block = evaluateSmtpBlockMessages(input);
	return block ?? evaluateDeferralGate(input);
}

/**
 * The block half, on its own: a `halt` when receivers are refusing this sending
 * identity, `null` when they are not or when we cannot tell.
 *
 * `null` rather than a hold, because "no block messages" is not thin evidence
 * about DEFERRALS — the rate check behind it is perfectly capable of deciding,
 * and turning a quiet block detector into a hold would freeze every cell that has
 * nothing wrong with it.
 *
 * LIVE SINCE ISSUE #501 CLOSED, and BOTH of the MTA's 4xx paths are why. The
 * classification is the MTA's (`apps/mta/src/dispatch/outcome.ts`) and each
 * branch now reports its verdict as a TYPED category on an `smtp.classified`
 * webhook — the RETRYABLE one, which used to emit no `notify_convex` event at
 * all and which supplies this clause's DENOMINATOR, and the NON-RETRYABLE one,
 * which also produces a bounce and supplies the NUMERATOR. Wiring only the
 * second would have delivered refusals over a denominator made of refusals: a
 * 100% block rate on the first one any cell ever collected.
 *
 * The category travels as a field and is never re-parsed out of the bounce's
 * prose `message`: a second classifier is free to disagree with the first, which
 * is what `@owlat/shared/smtpBlockCategories` exists to prevent.
 *
 * `analytics/smtpResponseCategories.ts` receives it into a per-(org, cell, arm,
 * day) sharded counter, and BOTH readers of this evaluator summarize it over
 * their own window — `loadCellInput` over the controller's 24 hours,
 * `deliverabilityDashboard` over the screen's seven days.
 *
 * ABSENCE IS STILL THE FIRST BRANCH BELOW, and it is not a defect. A cell whose
 * window contains no classified response at all gets `null` — not a zeroed
 * observation, which would read as "we measured, and nobody refused us" — so the
 * clause yields no verdict and the deferral rate decides on its own. The
 * arithmetic, the sample floor, the freshness rule and the block-versus-pressure
 * split stay pinned by `__tests__/smtpBlockMessage.test.ts` against the SHARED
 * fixture the MTA's own suite classifies; that the clause is REACHED from a real
 * deployment's rows is pinned by `delivery/__tests__/smtpBlockWiring.test.ts`.
 */
export function evaluateSmtpBlockMessages(input: RampGateEvaluationInput): RampGateResult | null {
	const observation = input.smtpBlocks;
	if (!observation) return null;

	const { thresholds, sampleFloors } = input.config;
	const minSample = sampleFloors.smtpBlock;
	const observed = safeOutcomeCount(observation.observed);
	if (observed < minSample) return null;
	if (
		evidenceFreshness(
			observation.observedAt,
			input.now,
			thresholds,
			thresholds.maxEvidenceAgeMs
		) !== 'fresh'
	) {
		return null;
	}

	// The numerator IS the block subset, by construction (`summarizeSmtpBlocks`):
	// a window whose classified responses were all rate pressure sums to zero and
	// falls under the threshold below, so a producer that counted a throttle
	// cannot halt a healthy cell no matter how it filled the row.
	const rate = blockRate(observation);
	if (rate === null || rate < (thresholds.smtpBlockHalt as number)) return null;

	return {
		gate: 'deferral',
		status: 'halt',
		reason: 'block_message_detected',
		measurement: {
			...oneArmedMeasurement({
				thresholdRate: thresholds.smtpBlockHalt as number,
				ownSample: observed,
				minSample,
			}),
			ownRate: rate,
		},
		...DIRECT_MEASUREMENT,
	};
}

// ============================ gate 4 — engagement ===========================

/**
 * The trailing-baseline engagement comparison: the cell's recent 7-day window
 * against its own prior 30-day one.
 *
 * THREE things are relaxed relative to the concurrent ratio, and all three are
 * relaxed because the comparison got weaker rather than because we got braver.
 * The concurrent ratio holds subject, content, timing and audience constant by
 * construction — it is two arms of the SAME send. This holds NONE of them: it is
 * this week against last month, and a redesigned newsletter that opens 20% worse
 * is indistinguishable from a 20% placement loss (plan D14). So the floor drops
 * from 0.95 to 0.85, the window widens to 7 days, and the minimum sample rises
 * from 400 to 2000.
 *
 * TWO of those three are constants here; the 7-day WINDOW is not, because the
 * gate takes its windows as PARAMETERS (plan D15) and nothing in this piece
 * builds one. It lands with the cron that summarises the window (P3), rather than
 * sitting here as a constant with no consumer, asserted by a test to equal
 * itself (plan D20: no speculative seams).
 *
 * AND IT MAY NEVER JUSTIFY AN INCREASE. `WEAK_TRAILING_SIGNAL` carries
 * `mayJustifyIncrease: false`, which the aggregator enforces: this gate can pull a
 * share DOWN, and a window in which it is the only thing that passed is a window
 * with no evidence for going UP. Encoding that on the verdict rather than in a
 * caller's head is the point — a convention is something every future caller gets
 * one chance to forget.
 */
export const TRAILING_ENGAGEMENT_SPEC: EngagementComparisonSpec = {
	recentOf: (input) => input.ownRecent,
	recentFloorOf: (floors) => floors.engagementTrailing,
	referenceOf: (input) => input.ownPriorBaseline ?? null,
	referenceFloorOf: (floors) => floors.engagementTrailing,
	referenceMaxAgeOf: (thresholds) => thresholds.maxBaselineAgeMs,
	referenceArm: 'baseline',
	ratioFloor: ENGAGEMENT_GATE_THRESHOLDS.trailingBaselineRatio,
	failReason: 'trailing_baseline_breached',
	grade: WEAK_TRAILING_SIGNAL,
};

/** Gate 4, standalone: recent engagement >= 0.85x the cell's own 30-day trailing. */
export function evaluateTrailingEngagementGate(input: EngagementGateInput): RampGateResult {
	return evaluateEngagementComparison(TRAILING_ENGAGEMENT_SPEC, input);
}

/**
 * THE BOUNDARY GUARD. Whatever gate-4 result a caller hands the standalone
 * evaluator, it is re-graded to the weak trailing signal — AND RE-REASONED into
 * the baseline vocabulary — before it can influence anything.
 *
 * Belt and braces, and worth the braces. `TRAILING_ENGAGEMENT_SPEC` already
 * produces the right grade and the right reasons, so in the intended flow this
 * changes nothing — but the engagement result is the ONE gate the aggregator
 * receives pre-computed from outside, and a caller that wired the CONCURRENT
 * ratio into the standalone evaluator would otherwise smuggle a high-confidence,
 * increase-justifying verdict into a deployment that has no second arm to have
 * measured it with. The plan's asymmetry would then be satisfied everywhere
 * except at the one seam where it could be bypassed.
 *
 * RE-GRADING WITHOUT RE-REASONING IS HALF A GUARD. A hold reason exists to NAME
 * THE THING TO FIX (plan D12), and `reference_*` names a second transport. A
 * standalone deployment has none, so an audit row and an admin notification
 * carrying `reference_evidence_stale` send the operator hunting a relay that does
 * not exist — which is precisely why the `baseline_*` vocabulary was introduced.
 */
export function asTrailingEngagement(result: RampGateResult): RampGateResult {
	switch (result.status) {
		case 'fail':
			return {
				...result,
				reason:
					result.reason === 'reference_tolerance_breached'
						? 'trailing_baseline_breached'
						: result.reason,
				...WEAK_TRAILING_SIGNAL,
			};
		case 'insufficient_data':
			return { ...result, reason: asBaselineHoldReason(result.reason), ...WEAK_TRAILING_SIGNAL };
		default:
			return { ...result, ...WEAK_TRAILING_SIGNAL };
	}
}

// ============================ gate 5 — placement ============================

/**
 * Gate 5, standalone, re-exported from `seedGate.ts`.
 *
 * The seed cascade is shared with the reference-arm gate, so it lives beside it
 * rather than being copied here — but "where does the standalone implementation
 * live" must have ONE answer, so the entry point is reachable from this module
 * alongside its four siblings.
 */
export { evaluateStandaloneSeedPlacementGate };
