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
 * it against the deferral or bounce gate before acting. Declared here so the
 * controller keys off a name rather than re-deriving the policy.
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
	/** Seeds per arm before the placement tripwire may return a verdict (D17). */
	readonly seedPlacement: number;
}

export const RAMP_GATE_SAMPLE_FLOORS: RampGateSampleFloors = {
	hardBounce: 200,
	deferral: 200,
	complaint: 1000,
	engagement: 400,
	seedPlacement: 5,
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
	/** Gate 5: own-arm seed inbox floor, absolute. */
	readonly seedInboxMin: RateFraction;
	/** Gate 5: own arm may fall below the reference arm by at most this much. */
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

export const RAMP_GATE_THRESHOLDS: RampGateThresholds = {
	hardBounceMax: rateFraction(0.02),
	hardBounceTolerance: percentagePoints(0.5),
	deferralMax: rateFraction(0.1),
	deferralHalt: rateFraction(0.25),
	complaintMax: rateFraction(0.001),
	complaintTolerance: percentagePoints(0.05),
	seedInboxMin: rateFraction(0.9),
	seedInboxTolerance: percentagePoints(5),
	maxEvidenceAgeMs: 48 * HOUR_MS,
	maxFutureSkewMs: DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS,
};

/**
 * Per-stream ramp constants (plan D6/D9). Defined ONCE here; the AIMD
 * controller (P3-2) reuses this object rather than re-declaring the numbers.
 *
 * Transactional starts at zero and ramps LAST — it is the mail a failure hurts
 * most — but once started it moves in the smallest steps.
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
