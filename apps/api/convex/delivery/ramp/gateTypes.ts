/**
 * Ramp controller — the gate vocabulary (plan D3, D12, D15).
 *
 * Types only: what a gate is asked, what it answers, and the numbers it must
 * hand back with the answer. Split from `gates.ts` so the two evaluator
 * implementations (reference-arm here, trailing-baseline in P1-7) and the
 * dashboard can share one vocabulary without importing either implementation.
 */

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
	| 'reference_tolerance_breached';

/** The single reason a gate can HALT. Only the deferral gate produces it. */
export type RampGateHaltReason = 'halt_threshold_breached';

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

interface RampGateResultBase {
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
			readonly reason: 'absolute_threshold_breached' | 'reference_tolerance_breached';
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
	 * The `now` the evaluation ran against.
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
