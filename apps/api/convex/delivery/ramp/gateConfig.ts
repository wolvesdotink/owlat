/**
 * Ramp controller — units and per-stream constants (plan D6, D9, D10, D15).
 *
 * UNITS ARE A TYPE-LEVEL CONCERN. This module decides whether a deployment
 * ramps into the spam folder, and every threshold in the plan is quoted in two
 * different units in the same sentence ("own arm <= 2% AND <= reference arm +
 * 0.5pp"). A percentage-point tolerance and a rate fraction are both "small
 * numbers near zero", so a mix-up is invisible at review time and catastrophic
 * at runtime: 0.5 read as a fraction is a 50-point tolerance.
 *
 * So the two units are distinct BRANDED types. They cannot be assigned to each
 * other, cannot be added to each other, and can only be produced through the
 * two constructors below. `ppToFraction` is the only bridge.
 */

import {
	DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS,
	type DeliverabilityStream,
} from '@owlat/shared/deliverabilityRouting';
import {
	SEED_MIN_OBSERVATIONS,
	SEED_REACHED_THRESHOLD,
	SEED_REFERENCE_TOLERANCE,
} from '@owlat/shared/seedPlacement';
import type { RampGateId } from './gateTypes';

/** A rate in [0, 1]. 0.02 means 2%. */
export type RateFraction = number & { readonly __unit: 'rate_fraction' };

/** A difference between two rates, in percentage points. 0.5 means 0.5pp. */
export type PercentagePoints = number & { readonly __unit: 'percentage_points' };

export function rateFraction(value: number): RateFraction {
	return value as RateFraction;
}

export function percentagePoints(value: number): PercentagePoints {
	return value as PercentagePoints;
}

/** The ONE conversion. A tolerance of 0.5pp is a rate difference of 0.005. */
export function ppToFraction(value: PercentagePoints): RateFraction {
	return ((value as number) / 100) as RateFraction;
}

/**
 * Which gates are OPTIONAL, declared ONCE (plan D2). Optionality is a fixed
 * property of the gate, not of a particular evaluation: an optional gate's
 * `insufficient_data` never holds the ramp, because a deployment with no seed
 * mailboxes is a supported configuration rather than an incomplete setup. Its
 * `fail` still counts in full.
 *
 * The aggregator consults this by gate id rather than trusting a flag on the
 * result, so a caller-supplied result (the engagement gate, P1-5) cannot remove
 * itself from the ramp's holding logic by mislabelling itself.
 */
export const OPTIONAL_RAMP_GATES: ReadonlySet<RampGateId> = new Set<RampGateId>(['seed_placement']);

/**
 * Gates whose FAIL is a tripwire rather than a measurement (plan D17). Seeds are
 * 5-10 mailboxes: a collapse across all of them is actionable at any sample
 * size, but it is SUSPECT on its own and the controller (P3-2) must corroborate
 * it against the deferral or bounce gate before acting.
 *
 * THIS SET ONLY NAMES THE GATES. What the flag MEANS is decided downstream:
 * `aggregateRampGates` sets `requiresCorroboration` when a gate named here is
 * alone at the winning rank, and `controller.ts` / `paceActuator.ts` answer it
 * with an `awaiting_corroboration` hold instead of a decrease. That is the whole
 * of the corroboration behaviour the ramp runs.
 *
 * `resolveSeedTripwire` in `@owlat/shared/seedPlacement` states the same rule
 * over the provider roll-up, but through `analytics.seedPlacement.getGateVerdict`
 * — an internal query with no production caller. Two routes to one rule is one
 * more than D5 allows; it is tracked in issue #504 rather than cited here as
 * though the ramp went through it.
 */
export const CORROBORATION_REQUIRED_RAMP_GATES: ReadonlySet<RampGateId> = new Set<RampGateId>([
	'seed_placement',
]);

/**
 * Minimum samples (plan D10). A gate returning a verdict below its minimum
 * sample is a defect, so every threshold carries the sample size at which it
 * first means anything.
 *
 * The rule of thumb is 1/threshold observations before the threshold can be
 * resolved at all (a 0.1% complaint rate is meaningless under 1000 sends: the
 * first single complaint already lands at 0.1%), widened for noise where the
 * threshold is coarse.
 */
export interface RampGateSampleFloors {
	/** Sends per arm before the hard-bounce gate may return a verdict. */
	readonly hardBounce: number;
	/** Sends (own arm only) before the deferral gate may return a verdict. */
	readonly deferral: number;
	/** Sends per arm before the complaint gate may return a verdict. */
	readonly complaint: number;
	/** Calibration-slice sends per arm for the concurrent engagement gate (D10). */
	readonly engagement: number;
	/**
	 * Calibration-slice sends in the RECENT window of the slow-poison floor (D10).
	 *
	 * A distinct knob from `engagement` even though the two currently agree: they
	 * govern different windows (one evaluation window vs the trailing recent one)
	 * and a controller that changes its cadence must be able to move one without
	 * silently moving the other.
	 */
	readonly engagementRecent: number;
	/**
	 * Calibration-slice sends the STANDALONE trailing engagement gate requires
	 * (plan D10's second minimum: >=2000 sends over a 7-day window).
	 *
	 * 5x the concurrent floor, and deliberately so. The concurrent gate compares
	 * two arms of the SAME send, so subject, content, timing and audience are held
	 * constant by construction and 400 per arm resolves a 5% relative move. The
	 * trailing variant compares two DIFFERENT WEEKS, where every one of those
	 * factors has moved; a floor that ignored the extra variance would let ordinary
	 * editorial noise retreat a healthy cell.
	 */
	readonly engagementTrailing: number;
	/**
	 * Classified SMTP responses before the block-message hard stop may fire.
	 *
	 * Small (tens, not hundreds) and deliberately so: the denominator here is
	 * FAILURE RESPONSES, not sends, and a healthy cell produces very few of them.
	 * A floor scaled to the send counters would mean the block detector never
	 * reached its minimum sample on precisely the cells that are working.
	 */
	readonly smtpBlock: number;
	/**
	 * Seeds per arm before the placement tripwire may return a verdict (D17).
	 *
	 * DERIVED, not declared: the roll-up in `@owlat/shared/seedPlacement` is what
	 * actually enforces it, and gate 5 reports this number beside the sample it
	 * counted. Two spellings of one floor is a screen that says "3 of 5".
	 */
	readonly seedPlacement: number;
}

export const RAMP_GATE_SAMPLE_FLOORS: RampGateSampleFloors = {
	hardBounce: 200,
	deferral: 200,
	complaint: 1000,
	engagement: 400,
	engagementRecent: 400,
	engagementTrailing: 2000,
	smtpBlock: 20,
	seedPlacement: SEED_MIN_OBSERVATIONS,
};

/**
 * Gate thresholds. Shared by every stream — a 2% hard-bounce rate is not more
 * acceptable on transactional mail than on campaign mail. What varies per
 * stream is the RAMP (how fast the share moves), not the safety limits.
 */
export interface RampGateThresholds {
	/** Gate 1: own-arm hard bounce ceiling, absolute. */
	readonly hardBounceMax: RateFraction;
	/** Gate 1: own arm may exceed the reference arm by at most this much. */
	readonly hardBounceTolerance: PercentagePoints;
	/** Gate 2: own-arm 4xx deferral ceiling, absolute. */
	readonly deferralMax: RateFraction;
	/** Gate 2: at or above this the cell HALTS — a hard stop, not a normal fail. */
	readonly deferralHalt: RateFraction;
	/** Gate 3: own-arm complaint ceiling, absolute. */
	readonly complaintMax: RateFraction;
	/** Gate 3: own arm may exceed the reference arm by at most this much. */
	readonly complaintTolerance: PercentagePoints;
	/**
	 * STANDALONE gate 1: the own arm's hard-bounce rate may be at most this
	 * MULTIPLE of the cell's own 30-day trailing rate, on top of the absolute 2%
	 * ceiling. A dimensionless multiple, not a rate and not percentage points.
	 *
	 * 1.5x rather than a tighter number because a trailing self-comparison carries
	 * list-decay and seasonal noise that a concurrent arm comparison does not: the
	 * absolute ceiling is the precise instrument here, and this one exists to catch
	 * a cell whose bounce rate is climbing fast while still nominally "under 2%".
	 */
	readonly hardBounceTrailingMultiple: number;
	/**
	 * STANDALONE gate 3: with no feedback loop, the one-click UNSUBSCRIBE rate at
	 * or above this multiple of the cell's own trailing unsubscribe rate is treated
	 * as a complaint-equivalent breach.
	 *
	 * Wide (3x) because it is a PROXY and is labelled as one: unsubscribes move
	 * with campaign content, so a narrow multiple would retreat the ramp for
	 * editorial reasons. A tripling against the cell's own recent history is not
	 * editorial.
	 */
	readonly unsubscribeProxyMultiple: number;
	/**
	 * STANDALONE gate 2: the share of classified SMTP responses that may be BLOCK
	 * messages before the cell HALTS.
	 *
	 * Not zero. A single misconfigured receiver returning a policy rejection is
	 * noise on any real volume, and a halt on one response would make the ramp
	 * unusable. 0.5% of a window's classified responses saying "we are refusing
	 * this sender" is not noise.
	 */
	readonly smtpBlockHalt: RateFraction;
	/**
	 * Gate 5: own-arm seed inbox floor, absolute — and the reference tolerance
	 * below it.
	 *
	 * BOTH ARE DERIVED FROM `@owlat/shared/seedPlacement`, which is where the
	 * roll-up that applies them lives. Gate 5 never compares a rate against
	 * either of these: it consumes the roll-up's STATUS and reports these two
	 * numbers only so the screen can render the line the verdict was measured
	 * against (plan D5 — the controller and the dashboard may not disagree).
	 */
	readonly seedInboxMin: RateFraction;
	readonly seedInboxTolerance: PercentagePoints;
	/**
	 * Evidence older than this is not evidence. A gate whose arm has no fresher
	 * observation than this holds (`insufficient_data`) rather than passing on a
	 * stale window (plan D9/D10 — never increase without fresh evidence).
	 *
	 * Deliberately much larger than the routing snapshot's staleness window: a
	 * transport-outcome bucket is a DAILY aggregate of a whole cell, not a
	 * ten-minute health snapshot, so 48h is one clean window plus slack rather
	 * than a liveness check.
	 */
	readonly maxEvidenceAgeMs: number;
	/**
	 * The SAME rule for a series whose window is HISTORICAL BY CONTRACT.
	 *
	 * `maxEvidenceAgeMs` encodes "never increase a share on an observation older
	 * than one clean window" — a statement about CONCURRENT evidence, and the only
	 * kind gates 1/2/3/5 and gate 4a ever read. The slow-poison floor (gate 4b)
	 * compares the recent window against the cell's PRIOR 30-day window, which
	 * ENDS a week ago and may have gone quiet at its own start, so its newest
	 * observation is between 7 and 30 days old on every healthy input. Judged by
	 * the concurrent rule it is unconditionally stale and the tripwire never
	 * actuates.
	 *
	 * So the baseline gets its own allowance — 33 days, the full width of the
	 * contracted window plus slack — rather than `maxEvidenceAgeMs` being widened,
	 * which would loosen "never increase without fresh evidence" (plan D9/D10) for
	 * every gate that legitimately depends on it.
	 */
	readonly maxBaselineAgeMs: number;
	/**
	 * Clock skew tolerance for `lastRecordedAt` in the future. Beyond it the
	 * evidence is not trusted and the gate holds.
	 *
	 * This is the SAME physical property the shipped routing-snapshot validator
	 * governs — the MTA<->Convex clock gap — so it is the same number, imported
	 * rather than re-chosen. Two allowances would mean a skew the snapshot
	 * validator rejects could still be accepted here as fresh evidence.
	 */
	readonly maxFutureSkewMs: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RAMP_GATE_THRESHOLDS: RampGateThresholds = {
	hardBounceMax: rateFraction(0.02),
	hardBounceTolerance: percentagePoints(0.5),
	deferralMax: rateFraction(0.1),
	deferralHalt: rateFraction(0.25),
	complaintMax: rateFraction(0.001),
	complaintTolerance: percentagePoints(0.05),
	hardBounceTrailingMultiple: 1.5,
	unsubscribeProxyMultiple: 3,
	smtpBlockHalt: rateFraction(0.005),
	seedInboxMin: rateFraction(SEED_REACHED_THRESHOLD),
	seedInboxTolerance: percentagePoints(SEED_REFERENCE_TOLERANCE * 100),
	maxEvidenceAgeMs: 48 * HOUR_MS,
	maxBaselineAgeMs: 33 * DAY_MS,
	maxFutureSkewMs: DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS,
};

/**
 * Per-stream ramp constants (ADR-0054 §4, plan D6/D9). Defined ONCE here; the
 * AIMD controller (P3-2) reuses this object rather than re-declaring the
 * numbers. Like `RAMP_AIMD`, these are a safety surface rather than a config
 * surface — `docs/adr/0054-deliverability-ramp-controller.md` argues why.
 *
 * Transactional starts at zero and ramps LAST — it is the mail a failure hurts
 * most — but once started it moves in the smallest steps.
 *
 * THIS TABLE IS THE EQUIPPED HALF ONLY — read `cleanWindowsRequired` as "with a
 * reference arm". The plan's standalone substitution (K_CLEAN 3 -> 5, step
 * halved, because the evidence behind each clean window is weaker without a
 * reference arm) is APPLIED IN EXACTLY ONE PLACE: the SUBSTITUTION TABLE's
 * `reference_transport` entry (`ramp/degradationMatrix.ts`:
 * `cleanWindowsRequired: 5`, `stepMultiplier: 0.5`), folded onto this table by
 * `ramp/degradation.ts`.
 *
 * NOT THE `conservative` PRESET, which an earlier revision of this paragraph
 * named. Defaulting a standalone deployment to that preset made the SAME fact
 * halve the SAME step twice — a quarter step instead of a half — so the fallback
 * is now the identity preset and a preset is only ever the OPERATOR'S choice
 * (`delivery/rampPresets.ts` and `ramp/presetConfig.ts` carry the full note; the
 * composition is pinned by `__tests__/presetDegradationComposition.test.ts`).
 * There is deliberately no second standalone constant table and no pending
 * substitution to land later.
 */
export interface RampStreamConfig {
	readonly stream: DeliverabilityStream;
	/**
	 * Share the cell starts at when the controller first writes it, as a
	 * FRACTION — branded, so the controller's `s + step` cannot add it to (or
	 * confuse it with) the percentage-point step sitting next to it.
	 */
	readonly initialShareFraction: RateFraction;
	/** Additive increase per clean window, in percentage points of share. */
	readonly increaseStep: PercentagePoints;
	/** Consecutive clean windows required before any increase (K_CLEAN, D9). */
	readonly cleanWindowsRequired: number;
	readonly thresholds: RampGateThresholds;
	readonly sampleFloors: RampGateSampleFloors;
}

export const RAMP_STREAM_CONFIGS: Readonly<Record<DeliverabilityStream, RampStreamConfig>> = {
	campaign: {
		stream: 'campaign',
		initialShareFraction: rateFraction(0.02),
		increaseStep: percentagePoints(5),
		cleanWindowsRequired: 3,
		thresholds: RAMP_GATE_THRESHOLDS,
		sampleFloors: RAMP_GATE_SAMPLE_FLOORS,
	},
	automation: {
		stream: 'automation',
		initialShareFraction: rateFraction(0.05),
		increaseStep: percentagePoints(5),
		cleanWindowsRequired: 3,
		thresholds: RAMP_GATE_THRESHOLDS,
		sampleFloors: RAMP_GATE_SAMPLE_FLOORS,
	},
	transactional: {
		stream: 'transactional',
		initialShareFraction: rateFraction(0),
		increaseStep: percentagePoints(3),
		cleanWindowsRequired: 3,
		thresholds: RAMP_GATE_THRESHOLDS,
		sampleFloors: RAMP_GATE_SAMPLE_FLOORS,
	},
};
