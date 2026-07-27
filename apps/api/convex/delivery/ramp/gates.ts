/**
 * Ramp controller — the GATE EVALUATION CORE (plan D9, D10, D12, D15).
 *
 * This is where the controller's correctness lives. Everything here is a pure,
 * total function of its arguments: no clock, no database, no environment, no
 * randomness. `now` is a parameter. Identical inputs give identical outputs,
 * forever, which is what makes the ramp's behaviour reviewable against fixtures
 * instead of against production.
 *
 * WHAT A GATE RETURNS. Not a boolean — a verdict TOGETHER WITH THE NUMBERS THAT
 * PRODUCED IT (plan D12). The audit row and the delivery dashboard both render
 * those numbers, so the measurement is part of the return type rather than
 * something the caller reconstructs (and reconstructs differently in two
 * places, which is exactly how a controller and a dashboard come to disagree).
 *
 * WHAT IS NOT HERE. Gate 4 (engagement ratio) lives in its own module because
 * of its MPP handling; the aggregator takes it as a pre-computed result. The
 * aggregator itself is in `gateEvaluation.ts`. The "is this evidence usable at
 * all" rules — freshness, clock skew, thin samples, poisoned rates — live in
 * `gateEvidence.ts`, shared with gate 4 so the safety property has exactly one
 * implementation.
 */

import { ppToFraction } from './gateConfig';
import type {
	PercentagePoints,
	RampGateSampleFloors,
	RampGateThresholds,
	RateFraction,
} from './gateConfig';
import {
	armEvidence,
	evidenceFreshness,
	evidenceReason,
	insufficient,
	safeRate,
	type ArmEvidence,
} from './gateEvidence';
import type {
	RampGateEvaluationInput,
	RampGateId,
	RampGateResult,
	SeedPlacementObservation,
} from './gateTypes';
import { safeOutcomeCount } from '../../analytics/transportOutcomeSummary';
import type { TransportOutcomeSummary } from '../../analytics/transportOutcomeSummary';

// ================================ helpers ===================================

/**
 * The comparative half of a two-armed gate: is the own arm within `tolerance`
 * PERCENTAGE POINTS of the reference arm?
 *
 * The pp -> fraction conversion happens HERE and only here, so no caller can
 * accidentally compare a percentage-point tolerance against a rate fraction.
 */
function withinTolerance(
	ownRate: number,
	referenceRate: number,
	tolerance: PercentagePoints,
	direction: 'own_must_not_exceed' | 'own_must_not_fall_below'
): boolean {
	const toleranceFraction = ppToFraction(tolerance) as number;
	return direction === 'own_must_not_exceed'
		? ownRate <= referenceRate + toleranceFraction
		: ownRate >= referenceRate - toleranceFraction;
}

// ========================= the ceiling gates (1 and 3) =======================

/**
 * Gates 1 and 3 are the SAME gate with different numbers: "own arm under an
 * absolute ceiling AND within tolerance of the reference arm". One map both
 * sites share, rather than a copied cascade per gate — the ordering below IS
 * the safety property, and two copies would be two chances to get it subtly
 * different.
 */
interface CeilingGateSpec {
	readonly gate: Extract<RampGateId, 'hard_bounce' | 'complaint'>;
	readonly rateOf: (summary: TransportOutcomeSummary) => number;
	readonly thresholdOf: (thresholds: RampGateThresholds) => RateFraction;
	readonly toleranceOf: (thresholds: RampGateThresholds) => PercentagePoints;
	readonly floorOf: (floors: RampGateSampleFloors) => number;
}

const HARD_BOUNCE_SPEC: CeilingGateSpec = {
	gate: 'hard_bounce',
	rateOf: (summary) => summary.hardBounceRate,
	thresholdOf: (thresholds) => thresholds.hardBounceMax,
	toleranceOf: (thresholds) => thresholds.hardBounceTolerance,
	floorOf: (floors) => floors.hardBounce,
};

const COMPLAINT_SPEC: CeilingGateSpec = {
	gate: 'complaint',
	rateOf: (summary) => summary.complaintRate,
	thresholdOf: (thresholds) => thresholds.complaintMax,
	toleranceOf: (thresholds) => thresholds.complaintTolerance,
	floorOf: (floors) => floors.complaint,
};

/**
 * ORDERING, and why:
 *   1. Own arm thin/stale -> insufficient_data. We know nothing.
 *   2. Own arm over the absolute ceiling -> fail, EVEN IF the reference arm is
 *      thin or absent. A 20% hard-bounce rate on ample own-arm data is real
 *      evidence; making it wait for the relay's sample would be a safety hole,
 *      and plan D2 forbids an external account being load-bearing — including
 *      load-bearing for a RETREAT.
 *   3. Reference arm thin/stale/absent -> insufficient_data. The comparative
 *      half is unmeasurable, so the gate holds rather than passing on half a
 *      check.
 *   4. Otherwise, compare the arms.
 */
function evaluateCeilingGate(
	spec: CeilingGateSpec,
	input: RampGateEvaluationInput
): RampGateResult {
	const { thresholds, sampleFloors } = input.config;
	const minSample = spec.floorOf(sampleFloors);
	const threshold = spec.thresholdOf(thresholds) as number;
	const tolerance = spec.toleranceOf(thresholds);

	const ownSample = safeOutcomeCount(input.own.sent);
	const referenceSample = input.reference ? safeOutcomeCount(input.reference.sent) : null;
	const ownRate = safeRate(spec.rateOf(input.own));
	const referenceRate = input.reference ? safeRate(spec.rateOf(input.reference)) : null;

	const shape = {
		thresholdRate: threshold,
		toleranceValuePp: tolerance as number,
		ownSample,
		referenceSample,
		minSample,
	} as const;

	const ownEvidence = armEvidence(input.own, ownSample, minSample, input.now, thresholds);
	if (ownEvidence !== 'fresh' || ownRate === null) {
		return insufficient(spec.gate, evidenceReason(ownEvidence, 'own'), {
			...shape,
			ownRate,
			referenceRate,
		});
	}

	if (ownRate > threshold) {
		return {
			gate: spec.gate,
			status: 'fail',
			reason: 'absolute_threshold_breached',
			measurement: { ...shape, ownRate, referenceRate },
		};
	}

	const referenceEvidence = armEvidence(
		input.reference,
		referenceSample ?? 0,
		minSample,
		input.now,
		thresholds
	);
	if (referenceEvidence !== 'fresh' || referenceRate === null) {
		return insufficient(spec.gate, evidenceReason(referenceEvidence, 'reference'), {
			...shape,
			ownRate,
			referenceRate,
		});
	}

	const within = withinTolerance(ownRate, referenceRate, tolerance, 'own_must_not_exceed');
	return within
		? {
				gate: spec.gate,
				status: 'pass',
				reason: 'within_threshold',
				measurement: { ...shape, ownRate, referenceRate },
			}
		: {
				gate: spec.gate,
				status: 'fail',
				reason: 'reference_tolerance_breached',
				measurement: { ...shape, ownRate, referenceRate },
			};
}

/** Gate 1 — HARD BOUNCE: own arm <= 2% AND <= reference arm + 0.5pp. */
export function evaluateHardBounceGate(input: RampGateEvaluationInput): RampGateResult {
	return evaluateCeilingGate(HARD_BOUNCE_SPEC, input);
}

/** Gate 3 — COMPLAINT: own arm <= 0.1% AND <= reference arm + 0.05pp. */
export function evaluateComplaintGate(input: RampGateEvaluationInput): RampGateResult {
	return evaluateCeilingGate(COMPLAINT_SPEC, input);
}

// ============================== the other gates =============================

/**
 * Gate 2 — DEFERRAL/4xx: own arm <= 10%; >= 25% is an IMMEDIATE HALT.
 *
 * Own arm only: a 4xx is the destination throttling THIS sending identity, and
 * the relay's deferral rate says nothing about ours. The halt is a distinct
 * status because the controller treats it as a hard stop rather than as an
 * ordinary multiplicative decrease.
 */
export function evaluateDeferralGate(input: RampGateEvaluationInput): RampGateResult {
	const { thresholds, sampleFloors } = input.config;
	const minSample = sampleFloors.deferral;
	const ownSample = safeOutcomeCount(input.own.sent);
	const ownRate = safeRate(input.own.deferralRate);
	const shape = {
		referenceRate: null,
		thresholdRate: thresholds.deferralMax as number,
		toleranceValuePp: null,
		ownSample,
		referenceSample: null,
		minSample,
	} as const;

	const evidence = armEvidence(input.own, ownSample, minSample, input.now, thresholds);
	if (evidence !== 'fresh' || ownRate === null) {
		return insufficient('deferral', evidenceReason(evidence, 'own'), { ...shape, ownRate });
	}

	if (ownRate >= (thresholds.deferralHalt as number)) {
		return {
			gate: 'deferral',
			status: 'halt',
			reason: 'halt_threshold_breached',
			measurement: { ...shape, ownRate },
		};
	}

	return ownRate <= (thresholds.deferralMax as number)
		? {
				gate: 'deferral',
				status: 'pass',
				reason: 'within_threshold',
				measurement: { ...shape, ownRate },
			}
		: {
				gate: 'deferral',
				status: 'fail',
				reason: 'absolute_threshold_breached',
				measurement: { ...shape, ownRate },
			};
}

function seedTotal(observation: SeedPlacementObservation | null | undefined): number {
	if (!observation) return 0;
	return (
		safeOutcomeCount(observation.inbox) +
		safeOutcomeCount(observation.spam) +
		safeOutcomeCount(observation.missing)
	);
}

function seedInboxRate(observation: SeedPlacementObservation | null | undefined): number | null {
	const total = seedTotal(observation);
	if (!observation || total <= 0) return null;
	return Math.min(1, safeOutcomeCount(observation.inbox) / total);
}

function seedEvidence(
	observation: SeedPlacementObservation | null | undefined,
	minSeeds: number,
	now: number,
	thresholds: RampGateThresholds
): ArmEvidence {
	if (!observation) return 'absent';
	const total = seedTotal(observation);
	if (total <= 0 || total < minSeeds) return 'thin';
	return evidenceFreshness(observation.observedAt, now, thresholds);
}

/**
 * Gate 5 — SEED PLACEMENT (OPTIONAL): inbox >= 90% AND >= reference - 5pp.
 *
 * Absent seed data returns `insufficient_data`, NEVER `fail` (plan D2) — and
 * because the gate is listed in `OPTIONAL_RAMP_GATES`, that `insufficient_data`
 * does not hold the ramp either: it only lowers measurement confidence. A
 * deployment with zero seed mailboxes is a supported configuration, not an
 * incomplete setup.
 *
 * Seeds are a tripwire, not a gauge (plan D17): what is consumed is the
 * verdict, with the sample carried alongside so nothing renders the rate as a
 * percentage anyone would quote. A `fail` here is SUSPECT on a sample of five,
 * which is why this gate is listed in `CORROBORATION_REQUIRED_RAMP_GATES` and
 * the aggregate evaluation flags `requiresCorroboration` when it decides.
 */
export function evaluateSeedPlacementGate(input: RampGateEvaluationInput): RampGateResult {
	const { thresholds, sampleFloors } = input.config;
	const minSample = sampleFloors.seedPlacement;
	const ownRate = seedInboxRate(input.ownSeeds);
	const referenceRate = seedInboxRate(input.referenceSeeds);
	const shape = {
		referenceRate,
		thresholdRate: thresholds.seedInboxMin as number,
		toleranceValuePp: thresholds.seedInboxTolerance as number,
		ownSample: seedTotal(input.ownSeeds),
		referenceSample: input.referenceSeeds ? seedTotal(input.referenceSeeds) : null,
		minSample,
	} as const;

	const ownEvidence = seedEvidence(input.ownSeeds, minSample, input.now, thresholds);
	if (ownEvidence !== 'fresh' || ownRate === null) {
		return insufficient('seed_placement', evidenceReason(ownEvidence, 'own'), {
			...shape,
			ownRate,
		});
	}

	if (ownRate < (thresholds.seedInboxMin as number)) {
		return {
			gate: 'seed_placement',
			status: 'fail',
			reason: 'absolute_threshold_breached',
			measurement: { ...shape, ownRate },
		};
	}

	const referenceEvidence = seedEvidence(input.referenceSeeds, minSample, input.now, thresholds);
	if (referenceEvidence !== 'fresh' || referenceRate === null) {
		return insufficient('seed_placement', evidenceReason(referenceEvidence, 'reference'), {
			...shape,
			ownRate,
		});
	}

	const within = withinTolerance(
		ownRate,
		referenceRate,
		thresholds.seedInboxTolerance,
		'own_must_not_fall_below'
	);
	return within
		? {
				gate: 'seed_placement',
				status: 'pass',
				reason: 'within_threshold',
				measurement: { ...shape, ownRate },
			}
		: {
				gate: 'seed_placement',
				status: 'fail',
				reason: 'reference_tolerance_breached',
				measurement: { ...shape, ownRate },
			};
}
