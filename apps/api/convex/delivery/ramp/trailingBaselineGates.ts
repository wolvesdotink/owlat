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
 *   2 DEFERRAL/4xx UNCHANGED, and PROMOTED TO PRIMARY. Plus per-ISP BLOCK-MESSAGE
 *                  detection from the shipped SMTP classifier as a HARD STOP.
 *                  Confidence HIGH. Receivers tell us a great deal in their 4xx
 *                  and 5xx text — rate pressure, blocklist hits, content
 *                  rejections, policy blocks — and this is the configuration that
 *                  leans on it hardest.
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
 *
 * WHAT IS NOT HERE. No cascade. Every gate below is the SAME evaluator the
 * reference-arm implementation uses, handed a different SPEC — a different second
 * series, a different unit, a different grade. That is deliberate and it is the
 * plan's defence against the degraded path rotting: a fix to the freshness rule,
 * the thin-sample rule or the poisoned-rate rule lands in both implementations at
 * once because there is only one of each.
 *
 * PURE (plan D15): `now` is a parameter, nothing reads a clock, a database or the
 * environment.
 */

import { isSmtpBlockCategory } from '@owlat/shared/smtpBlockCategories';
import { evaluateCeilingGate, type CeilingGateSpec } from './ceilingGate';
import { ENGAGEMENT_GATE_THRESHOLDS } from './engagementConfig';
import {
	evaluateEngagementComparison,
	type EngagementComparisonSpec,
	type EngagementGateInput,
} from './engagementGate';
import { evaluateDeferralGate } from './gates';
import { evidenceFreshness, safeRate } from './gateEvidence';
import { DIRECT_MEASUREMENT, PROXY_MEASUREMENT, WEAK_TRAILING_SIGNAL } from './gateGrades';
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
		comparison: { kind: 'multiple', of: (t) => t.hardBounceTrailingMultiple },
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
		comparison: { kind: 'multiple', of: (t) => t.unsubscribeProxyMultiple },
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

/** The share of classified responses that were BLOCK messages, or `null`. */
function blockRate(observation: SmtpBlockObservation): number | null {
	const observed = safeOutcomeCount(observation.observed);
	if (observed <= 0) return null;
	return safeRate(safeOutcomeCount(observation.blocked) / observed);
}

/**
 * Gate 2, standalone: THE PRIMARY FAST SIGNAL.
 *
 * Unchanged in its arithmetic — the 4xx ceiling and the halt line are the shipped
 * ones, because they never depended on a third party in the first place — and
 * extended with what the responses SAY rather than only how many there were.
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

	// The COUNT says how much, the CATEGORIES say what. Both are required: a
	// producer that counted a throttle as a block (or a legacy row whose categories
	// predate this vocabulary) must not be able to halt a healthy cell, and the
	// admin notification has nothing to name without them.
	const blockingCategories = observation.categories.filter(isSmtpBlockCategory);
	if (blockingCategories.length === 0) return null;

	const rate = blockRate(observation);
	if (rate === null || rate < (thresholds.smtpBlockHalt as number)) return null;

	return {
		gate: 'deferral',
		status: 'halt',
		reason: 'block_message_detected',
		measurement: {
			ownRate: rate,
			referenceRate: null,
			thresholdRate: thresholds.smtpBlockHalt as number,
			toleranceValuePp: null,
			ownSample: observed,
			referenceSample: null,
			minSample,
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
 * evaluator, it is re-graded to the weak trailing signal before it can influence
 * anything.
 *
 * Belt and braces, and worth the braces. `TRAILING_ENGAGEMENT_SPEC` already
 * produces the right grade, so in the intended flow this changes nothing — but the
 * engagement result is the ONE gate the aggregator receives pre-computed from
 * outside, and a caller that wired the CONCURRENT ratio into the standalone
 * evaluator would otherwise smuggle a high-confidence, increase-justifying verdict
 * into a deployment that has no second arm to have measured it with. The plan's
 * asymmetry would then be satisfied everywhere except at the one seam where it
 * could be bypassed.
 */
export function asTrailingEngagement(result: RampGateResult): RampGateResult {
	return { ...result, ...WEAK_TRAILING_SIGNAL };
}
