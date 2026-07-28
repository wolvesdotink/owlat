/**
 * Ramp controller — the gate vocabulary (plan D3, D12, D15).
 *
 * Types only: what a gate is asked, what it answers, and the numbers it must
 * hand back with the answer. Split from `gates.ts` so the two evaluator
 * implementations (reference-arm here, trailing-baseline in P1-7) and the
 * dashboard can share one vocabulary without importing either implementation.
 */

import type { SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';
import type { TransportOutcomeSummary } from '../../analytics/transportOutcomeSummary';
import type { RampStreamConfig } from './gateConfig';

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
	/** Denominator behind `ownRate` (sends, or seeds for the placement gate). */
	readonly ownSample: number;
	/** Denominator behind `referenceRate`, or `null` when absent. */
	readonly referenceSample: number | null;
	/**
	 * Minimum sample the gate requires of the OWN (recent) arm — the denominator
	 * behind `ownSample` — before it may return a verdict. It means the same
	 * thing on every verdict of every gate, so a generic renderer can print it
	 * next to `ownSample` without branching on `reason`.
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

export interface RampGateEvaluation {
	readonly verdict: RampVerdict;
	/** The gate that produced a `fail`/`halt`, or the one holding on thin data. */
	readonly failedGate?: RampGateId;
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
	 * The WEAKEST confidence among the gates that contributed (plan D14). This is
	 * the number the cell renders as "measurement confidence", and the reason the
	 * standalone UI can honestly offer "connect a relay or add seed mailboxes to
	 * improve" instead of pretending a proxy is a measurement.
	 */
	readonly confidence: RampGateConfidence;
	/**
	 * Whether ANY contributing gate passed with `mayJustifyIncrease`. When this is
	 * false the verdict can never be `pass`, so a low-confidence gate cannot be the
	 * sole justification for raising a share (plan D14). Carried on the evaluation
	 * — not just applied to the verdict — so the audit row (plan D12) can say WHY a
	 * window that looked clean did not advance the streak.
	 */
	readonly increaseEvidence: boolean;
	/** The `now` the evaluation ran against — echoed for the audit row. */
	readonly evaluatedAt: number;
}

/**
 * What receivers said in their own 4xx/5xx text over the window, reduced to the
 * only question the ramp asks of it: how many responses were BLOCK messages?
 *
 * The classification itself is the MTA's (`classifySmtpResponse`), and the
 * category names are the shared vocabulary in
 * `@owlat/shared/smtpBlockCategories` — this side counts, it does not parse.
 */
export interface SmtpBlockObservation {
	/** Responses classified into a category in `SMTP_BLOCK_CATEGORIES`. */
	readonly blocked: number;
	/** Every classified response over the window — the denominator. */
	readonly observed: number;
	/**
	 * The categories seen, for the audit row and the admin notification. Naming
	 * the category is what turns "the ramp halted" into "Gmail is rejecting the
	 * sending IP identity — check PTR and forward DNS".
	 *
	 * THE SHARED VOCABULARY, not free text. The stored row is
	 * `v.array(v.string())`, so the narrowing happens ONCE where that row is read
	 * (`isSmtpBlockCategory`) rather than on every element on every gate
	 * evaluation — a string that is not a category the classifier can emit is not
	 * evidence and must not reach the gate at all.
	 */
	readonly categories: readonly SmtpFailureCategory[];
	readonly observedAt: number;
}

/** Seed placement, as a tripwire and never as a gauge (plan D17). */
export interface SeedPlacementObservation {
	readonly inbox: number;
	readonly spam: number;
	readonly missing: number;
	readonly observedAt: number;
}

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
	 * Block-message counts from the shipped SMTP classifier over the window.
	 * Absent means "not observed", which holds; it never fails.
	 */
	readonly smtpBlocks?: SmtpBlockObservation | null;
	readonly ownSeeds?: SeedPlacementObservation | null;
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
