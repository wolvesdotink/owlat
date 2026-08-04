/**
 * Ramp controller — the gate vocabulary (plan D3, D12, D15).
 *
 * Types only: what a gate is asked, what it answers, and the numbers it must
 * hand back with the answer. Split from `gates.ts` so the two evaluator
 * implementations (reference-arm here, trailing-baseline in P1-7) and the
 * dashboard can share one vocabulary without importing either implementation.
 */

import type { SeedPlacementObservation, SmtpBlockObservation } from './gateObservations';
import type { TransportOutcomeSummary } from '../../analytics/transportOutcomeSummary';
import type { RampStreamConfig } from './gateConfig';

// The evidence shapes live in the domain sibling; re-exported here so the gate
// vocabulary keeps ONE import surface (see `gateObservations.ts`).
export type { SeedPlacementObservation, SmtpBlockObservation } from './gateObservations';

/**
 * A gate's verdict.
 *
 *  - `pass`               — the measurement is fresh, large enough, inside the threshold.
 *  - `fail`               — the measurement is fresh, large enough, outside it.
 *  - `insufficient_data`  — thin, stale or absent evidence. HOLDS (plan D10): the
 *                           controller neither increases nor decreases on it.
 *  - `halt`               — a hard stop that outranks an ordinary fail. Only the
 *                           deferral gate can produce it.
 */
export type RampGateStatus = 'pass' | 'fail' | 'insufficient_data' | 'halt';

export type RampGateId =
	| 'hard_bounce'
	| 'deferral'
	| 'complaint'
	| 'engagement_ratio'
	| 'seed_placement';

/**
 * Why a gate DECIDED — reachable only from `pass` and `fail`, because a gate
 * that held did not compare anything.
 */
export type RampGateDecidedReason =
	| 'within_threshold'
	| 'absolute_threshold_breached'
	| 'reference_tolerance_breached'
	/**
	 * The cell moved against ITS OWN 30-day trailing rate by more than the
	 * standalone substitution allows (plan's "gates, degraded honestly" table).
	 *
	 * A distinct reason from `reference_tolerance_breached` because the operator
	 * story is different in a way that changes what they go and look at: the
	 * reference reason means "the relay is doing better than we are", this one
	 * means "we are doing worse than we were last month", and there is no relay to
	 * inspect in the deployment that produces it.
	 */
	| 'trailing_baseline_breached';

/**
 * Why a gate can HALT.
 *
 *  - `halt_threshold_breached` — the deferral rate is at or above the halt line.
 *  - `block_message_detected`  — receivers are returning BLOCK messages (their
 *    own 4xx/5xx text says our content is spam, our sender identity is not
 *    authorised, or our IP is not one they take mail from). Distinct from a
 *    deferral-rate breach: throttling gets better by slowing down, a block does
 *    not get better by sending at all.
 */
export type RampGateHaltReason = 'halt_threshold_breached' | 'block_message_detected';

/**
 * Why a gate HELD. Every one of these says which arm was unusable and how, so
 * the admin notification can name the thing to fix (plan D12).
 */
export type RampGateHoldReason =
	| 'own_sample_below_floor'
	| 'reference_sample_below_floor'
	| 'own_evidence_stale'
	| 'reference_evidence_stale'
	/** The stored rate was NaN, infinite or out of range — a poisoned bucket, not a thin one. */
	| 'own_rate_unmeasurable'
	| 'reference_rate_unmeasurable'
	/**
	 * The slow-poison floor's second series is the cell's OWN prior window, not a
	 * second transport, so it gets its own vocabulary: an operator told
	 * "reference evidence stale" would go looking for a relay problem that does
	 * not exist, when the actual fix is "this cell has not sent enough, long
	 * enough, to be compared against its own past".
	 */
	| 'baseline_sample_below_floor'
	| 'baseline_evidence_stale'
	| 'baseline_rate_unmeasurable'
	/**
	 * A DIFFERENT STORY FROM `*_rate_unmeasurable`, and the distinction is the
	 * whole point of the two codes existing.
	 *
	 * `*_rate_unmeasurable` says the series' rate was NOT A NUMBER — a poisoned
	 * bucket, something to go and investigate. `*_not_a_denominator` says the rate
	 * was a perfectly good number that a RELATIVE comparison cannot be built on:
	 * a trailing window with zero hard bounces, or a baseline so high that `k *
	 * base` reaches 1 and the derived ceiling could never fail anything. Nothing
	 * is broken; there is simply no relative verdict to give, so the gate holds
	 * (plan D10).
	 *
	 * Reporting the second as the first tells an operator whose 30-day window is
	 * clean and complete that their trailing rate is corrupt — and the audit row
	 * and the admin notification key off exactly this code (plan D12).
	 */
	| 'reference_not_a_denominator'
	| 'baseline_not_a_denominator'
	/** A zero with no writer behind it is not a zero — see `evaluateDeferralGate`. */
	| 'own_deferral_telemetry_absent'
	| 'evidence_absent';

/**
 * Why a gate returned what it returned, as a stable machine-readable code. The
 * human sentence is rendered from this plus the measurement; the code is what
 * the audit row and the admin notification key off (plan D12).
 *
 * The union is split per status above so that a `pass` carrying a hold reason
 * is not a representable value.
 */
export type RampGateReason = RampGateDecidedReason | RampGateHaltReason | RampGateHoldReason;

/**
 * The numbers behind a verdict, in DOCUMENTED units: `*Rate` fields are
 * fractions in [0, 1]; `toleranceValuePp` is in percentage points. A rate and a
 * tolerance never share a field.
 */
interface RampGateMeasurementBase {
	/** The absolute threshold this gate compared against, as a fraction. */
	readonly thresholdRate: number;
	/**
	 * The RELATIVE floor a ratio gate applied, as a dimensionless multiple of
	 * `referenceRate` — 0.95 means "the own arm may engage 5% relatively worse".
	 * `thresholdRate` is the absolute rate that multiple works out to, so the two
	 * are never the same number in the same unit.
	 *
	 * A separate field rather than an overloaded `thresholdRate`: both are small
	 * numbers, and an audit row (plan D12) that cannot tell "a ratio floor of
	 * 0.95" from "an engagement floor of 95%" is a record nobody can act on. Only
	 * the engagement family sets it; the ceiling gates leave it absent.
	 */
	readonly ratioFloor?: number;
	/**
	 * The RELATIVE CEILING a ceiling gate applied, as a dimensionless multiple of
	 * `referenceRate` — 1.5 means "the own arm may bounce up to 50% relatively
	 * worse than the series it is compared against".
	 *
	 * The mirror image of `ratioFloor`, and a SEPARATE field from it for the same
	 * reason `ratioFloor` is separate from `thresholdRate`: a floor of 0.85 and a
	 * ceiling of 1.5 mean opposite things, and an audit row (plan D12) that
	 * reported one under the other's name would invert the story it tells. Only the
	 * standalone substitutions set it — the reference-arm gates express their
	 * comparative half in percentage points, in `toleranceValuePp`.
	 */
	readonly ratioCeiling?: number;
	/** The arm-vs-arm tolerance in percentage points, or `null` when the gate has none. */
	readonly toleranceValuePp: number | null;
	/**
	 * Denominator behind `ownRate`. It is SENDS on every gate and every reason but
	 * two, and the two are named by their `gate`/`reason` rather than left for a
	 * renderer to guess:
	 *
	 *  - gate `seed_placement` counts SEED PROBES — one shadow copy into one seed
	 *    mailbox for one send, so the same mailbox contributes once per send in
	 *    the window and the count is NOT a mailbox count;
	 *  - reason `block_message_detected` counts CLASSIFIED SMTP RESPONSES — the
	 *    block-message hard stop measures the share of a receiver's answers that
	 *    said "we are refusing this sender", which has nothing to do with how many
	 *    messages were handed over.
	 *
	 * A renderer that prints "N sends" unconditionally is wrong on both, and under
	 * plan D12 the audit row and the admin notification render from exactly this
	 * field — see `gateExplanation` in `apps/web/app/utils/deliverabilityMeasurement.ts`
	 * for the branch that keeps the sentence true.
	 */
	readonly ownSample: number;
	/** Denominator behind `referenceRate`, or `null` when absent. */
	readonly referenceSample: number | null;
	/**
	 * Minimum sample the gate requires of the OWN (recent) arm before it may
	 * return a verdict. ALWAYS IN THE SAME UNIT AS `ownSample` — the two are a
	 * pair, and the unit is the one `ownSample` documents above, so "24 of 20" is
	 * always a like-for-like comparison even where that unit is not sends.
	 */
	readonly minSample: number;
	/**
	 * Minimum sample the gate requires of the SECOND series — the denominator
	 * behind `referenceSample` — when that series has a floor of its own.
	 *
	 * A separate field rather than an overloaded `minSample`: the engagement
	 * family's two sub-gates compare against different second series (the
	 * concurrent reference arm, and the cell's own 30-day trailing baseline)
	 * whose floors differ by 3x, and an audit row (plan D12) that reports one
	 * arm's floor beside the other arm's sample asserts something false about
	 * both. Only the engagement family sets it; the ceiling gates leave it
	 * absent, as do one-armed gates.
	 */
	readonly referenceMinSample?: number;
}

/**
 * A measurement behind a DECIDED verdict. `ownRate` is non-null by
 * construction: a gate cannot decide without having measured its own arm, so no
 * consumer has to null-check a case that cannot occur.
 *
 * `referenceRate` stays nullable: a one-armed gate (deferral) has none, and an
 * absolute-ceiling breach is decided before the reference arm is consulted.
 */
export interface RampGateDecidedMeasurement extends RampGateMeasurementBase {
	readonly ownRate: number;
	readonly referenceRate: number | null;
}

/** A measurement behind a HOLD. Either arm may be unmeasurable — that is the point. */
export interface RampGateHoldMeasurement extends RampGateMeasurementBase {
	readonly ownRate: number | null;
	readonly referenceRate: number | null;
}

export type RampGateMeasurement = RampGateDecidedMeasurement | RampGateHoldMeasurement;

/**
 * HOW MUCH THE VERDICT IS WORTH (plan D14). Rendered on the cell, recorded in
 * the audit row, and — through `mayJustifyIncrease` — enforced by the aggregator.
 *
 *  - `high`   — the measurement is self-hosted and direct. Bounces and 4xx text
 *               come off our own wire and never depended on a third party.
 *  - `medium` — a proxy or a tripwire. The standalone complaint gate reading
 *               one-click unsubscribes instead of feedback-loop reports, or a
 *               placement sweep over 5-10 seed mailboxes.
 *  - `low`    — genuinely weak, and said so out loud rather than dressed up. The
 *               standalone engagement check cannot tell a redesigned newsletter
 *               from a placement loss.
 */
export type RampGateConfidence = 'high' | 'medium' | 'low';

/**
 * The two things every verdict carries besides the numbers.
 *
 * `mayJustifyIncrease` IS THE ASYMMETRY (plan D14), and it lives on the RESULT
 * rather than in a caller's head on purpose. "The weak gate may only ever cause a
 * decrease, never an increase" stated as a convention is a rule every future
 * caller gets one chance to forget; stated as a field the aggregator reads, a
 * caller cannot forget it at all. A gate with `mayJustifyIncrease: false` still
 * FAILS in full — it just cannot be the evidence that lets a share go up.
 */
export interface RampGateGrade {
	readonly confidence: RampGateConfidence;
	/**
	 * Whether a `pass` from this gate counts as evidence FOR AN INCREASE. `false`
	 * on a low-confidence gate; `true` everywhere else. Ignored on non-`pass`
	 * statuses, where the gate's answer counts in full whatever its confidence.
	 */
	readonly mayJustifyIncrease: boolean;
}

interface RampGateResultBase extends RampGateGrade {
	readonly gate: RampGateId;
}

/**
 * A gate's answer, discriminated on `status`. Optionality is NOT carried here:
 * it is a fixed property of the gate id (`OPTIONAL_RAMP_GATES` in gateConfig),
 * so no caller can exempt its own gate from the ramp's holding logic.
 */
export type RampGateResult =
	| (RampGateResultBase & {
			readonly status: 'pass';
			readonly reason: 'within_threshold';
			readonly measurement: RampGateDecidedMeasurement;
	  })
	| (RampGateResultBase & {
			readonly status: 'fail';
			readonly reason:
				| 'absolute_threshold_breached'
				| 'reference_tolerance_breached'
				| 'trailing_baseline_breached';
			readonly measurement: RampGateDecidedMeasurement;
	  })
	| (RampGateResultBase & {
			readonly status: 'halt';
			readonly reason: RampGateHaltReason;
			readonly measurement: RampGateDecidedMeasurement;
	  })
	| (RampGateResultBase & {
			readonly status: 'insufficient_data';
			readonly reason: RampGateHoldReason;
			readonly measurement: RampGateHoldMeasurement;
	  });

/** Aggregate verdict. `halt` is a strictly stronger `fail` (deferral hard stop). */
export type RampVerdict = 'pass' | 'fail' | 'halt' | 'insufficient_data';

interface RampGateEvaluationBase {
	/**
	 * The failing gate is a TRIPWIRE, not a measurement (plan D17): the
	 * controller must corroborate it against the deferral or bounce gate before
	 * acting on it. Only ever true alongside a `fail`/`halt` from a gate in
	 * `CORROBORATION_REQUIRED_RAMP_GATES`.
	 */
	readonly requiresCorroboration: boolean;
	/** Consecutive clean windows INCLUDING this one (plan D9's K_CLEAN input). */
	readonly cleanStreak: number;
	readonly perGate: readonly RampGateResult[];
	/**
	 * The WEAKEST confidence among the gates that DECIDED something (plan D14) —
	 * `low` when none did, because an evaluation nobody measured is not a
	 * well-measured one.
	 *
	 * PER-INSTRUMENT, AND NOT THE CELL'S CONFIDENCE. It grades the verdicts this
	 * evaluation actually reached: a standalone cell whose deferral gate decides
	 * at `high` while the two-armed gates hold measures `high` HERE, and that is
	 * the true sentence about the instrument. It is NOT the true sentence about
	 * the CELL, which has no second arm to tell a degradation from a bad week for
	 * the whole list — that judgement is `dashboardConfidence`'s, which caps this
	 * number by the measurement inputs the deployment does not have and is what
	 * the screen renders.
	 *
	 * THE TWO ARE NAMED APART ON PURPOSE. The audit row (plan D12) and the
	 * decrease notification record what the DECISION was worth, which is this
	 * one; anything answering "how well is this cell measured" wants the view's
	 * level instead. One name over both is how they drift back into two
	 * definitions of the same word.
	 */
	readonly measuredConfidence: RampGateConfidence;
	/**
	 * Whether ANY contributing gate passed with `mayJustifyIncrease`. When this is
	 * false the verdict can never be `pass`, so a low-confidence gate cannot be the
	 * sole justification for raising a share (plan D14). Carried on the evaluation
	 * — not just applied to the verdict — so the audit row (plan D12) can say WHY a
	 * window that looked clean did not advance the streak.
	 */
	readonly increaseEvidence: boolean;
	/**
	 * The `now` the evaluation ran against — echoed for the audit row.
	 *
	 * NOT decoration: the controller reads it to decide whether this aggregate is
	 * still EVIDENCE. An aggregate older than `maxEvidenceAgeMs`, or one stamped
	 * ahead of the clock by more than `maxFutureSkewMs`, holds the cell rather
	 * than buying it a step — the same freshness/skew model the shipped routing
	 * snapshot validator applies.
	 */
	readonly evaluatedAt: number;
}

/**
 * The gate aggregate, DISCRIMINATED ON `verdict`.
 *
 * A `fail` or a `halt` is the one shape that costs a cell half its share, and
 * the audit row for that retreat has to name what broke (plan D12). Making
 * `failedGate` REQUIRED on those two members is what stops a decrease from ever
 * being recorded with a reason that says it held: the alternative — one
 * interface with an optional flag — permits a breach with nothing to name, and
 * a silent retreat is exactly the failure mode the audit trail exists to
 * prevent. A `pass` names nothing; an `insufficient_data` may name the gate that
 * is holding.
 */
export type RampGateEvaluation =
	| (RampGateEvaluationBase & {
			readonly verdict: 'pass' | 'insufficient_data';
			/** The gate holding on thin data, when one can be named. */
			readonly failedGate?: RampGateId;
	  })
	| (RampGateEvaluationBase & {
			readonly verdict: 'fail' | 'halt';
			/** REQUIRED: a retreat always names the measurement that broke. */
			readonly failedGate: RampGateId;
	  });

export interface RampGateEvaluationInput {
	readonly config: RampStreamConfig;
	/** Own-MTA arm outcomes for the window. */
	readonly own: TransportOutcomeSummary;
	/**
	 * Reference (relay/ESP) arm outcomes, or `null` when no reference transport
	 * is configured. `null` is a SUPPORTED CONFIGURATION (plan D2), not an error.
	 *
	 * Under `referenceArmGateEvaluator` — the only implementation that exists
	 * today — `null` makes the two-armed gates (hard bounce, complaint, seed
	 * placement) HOLD, while the one-armed deferral gate keeps deciding. Nothing
	 * fails, nothing is blocked; the ramp simply moves on thinner evidence. P1-7
	 * adds the trailing-baseline evaluator that decides for a standalone
	 * deployment; the CALLER picks the evaluator, this field does not.
	 */
	readonly reference: TransportOutcomeSummary | null;
	/**
	 * The cell's OWN 30-day trailing window — the second series the standalone
	 * evaluator substitutes for the missing reference arm (gate 1's 1.5x rule and
	 * gate 3's 3x unsubscribe proxy).
	 *
	 * DISJOINT from the evaluation window, for the same reason gate 4b's baseline
	 * is: a trailing window that CONTAINS the window under test is dragged down by
	 * the very move it is supposed to detect, so the tripwire fires late and less
	 * often than its constant implies. Absent (a young cell) means the relative
	 * half cannot decide — never that it fails.
	 *
	 * Unused by `referenceArmGateEvaluator`, which has a concurrent second arm.
	 */
	readonly ownTrailingBaseline?: TransportOutcomeSummary | null;
	/**
	 * Whether this cell has a working COMPLAINT FEEDBACK LOOP (CFBL/ARF) — the
	 * shipped `apps/mta/src/bounce` FBL processor receiving reports for this
	 * sending identity.
	 *
	 * When true the standalone complaint gate measures real complaints at HIGH
	 * confidence; when absent or false it falls back to the one-click unsubscribe
	 * proxy at MEDIUM confidence and says so. Absence lowers confidence and does
	 * nothing else (plan D2).
	 */
	readonly hasComplaintFeedback?: boolean;
	/**
	 * Whether this cell's `deferred` counter is saying anything — observed from
	 * this cell's own arm over the telemetry span, never configured. Absent or
	 * `false` over an EMPTY numerator makes gate 2 hold rather than pass. Readers
	 * derive it through `hasUsableDeferralTelemetry`, which also bounds the hold.
	 */
	readonly hasDeferralTelemetry?: boolean;
	/**
	 * Block-message counts from the shipped SMTP classifier over the window.
	 * Absent means "not observed", which holds; it never fails.
	 *
	 * ABSENT IS THE ONLY STATE THERE IS TODAY (issue #501): the classifier runs in
	 * the MTA and nothing carries its per-category counts into Convex per (cell,
	 * arm), so no production reader supplies this field. See
	 * `gateObservations.ts` for what the shape is waiting on — said here as well
	 * because this is the declaration an author reaches for when wiring a gate.
	 */
	readonly smtpBlocks?: SmtpBlockObservation | null;
	/**
	 * This cell's OWN-arm seed sweep over the placement window, counted from the
	 * probe ledger by `analytics/seedPlacementSweeps.ts` and supplied by both
	 * readers of this input (`delivery/rampControllerInputs.ts`,
	 * `delivery/deliverabilityDashboard.ts`).
	 *
	 * Absent or `null` means this cell has no classified probes — no seed
	 * mailboxes, a cell whose stream the shadow copy does not cover, or a sweep
	 * that has not been polled yet. That HOLDS gate 5 and never fails it, and
	 * because seed placement is optional the hold costs the ramp nothing (D2).
	 */
	readonly ownSeeds?: SeedPlacementObservation | null;
	/**
	 * The same window's REFERENCE-arm sweep — gate 5's second clause. `null` on a
	 * standalone deployment, where the roll-up reports `no_reference_arm` and the
	 * absolute clause is the whole gate (D3's substitution).
	 */
	readonly referenceSeeds?: SeedPlacementObservation | null;
	/** Gate 4's result, computed elsewhere (MPP handling). Absent = not measured. */
	readonly engagement?: RampGateResult | null;
	/** Consecutive clean windows before this evaluation. */
	readonly previousCleanStreak: number;
	readonly now: number;
}

/**
 * Arguments to the aggregation seam, as ONE object rather than a positional
 * list.
 *
 * `previousCleanStreak` (a count of windows) and `now` (a millisecond epoch) are
 * both plain numbers and are mutually assignable, so a positional signature lets
 * a caller transpose them and still typecheck — producing a `cleanStreak` of
 * `Math.floor(epoch)`, which satisfies K_CLEAN instantly, and an `evaluatedAt`
 * of single digits. In the one module whose premise is that units are a
 * type-level concern, that is not a risk worth taking; naming the fields removes
 * it, and removes the positional churn P1-5/P1-7 would otherwise cause.
 */
export interface RampGateAggregationInput {
	readonly perGate: readonly RampGateResult[];
	/** Consecutive clean windows before this evaluation. */
	readonly previousCleanStreak: number;
	/** Millisecond epoch this evaluation runs against. */
	readonly now: number;
}

/**
 * The gate interface (plan D3). TWO implementations, both taking the same input
 * and returning the same evaluation, so the controller is written once.
 */
export interface RampGateEvaluator {
	readonly kind: 'reference_arm' | 'trailing_baseline';
	evaluate(input: RampGateEvaluationInput): RampGateEvaluation;
}
