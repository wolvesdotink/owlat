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
 * WHAT IS NOT HERE. The ceiling cascade gates 1 and 3 share — and that the
 * standalone substitutions reuse with a different second series — is in
 * `ceilingGate.ts`, and gate 5's seed cascade is in `seedGate.ts` for the same
 * reason and in the same shape. Gate 4 (engagement ratio) lives in its own module
 * because of its MPP handling; the aggregator takes it as a pre-computed result. The
 * aggregator itself is in `gateEvaluation.ts`. The "is this evidence usable at
 * all" rules — freshness, clock skew, thin samples, poisoned rates — live in
 * `gateEvidence.ts`, shared with gate 4 so the safety property has exactly one
 * implementation. The confidence grades are in `gateGrades.ts`.
 */

import { evaluateCeilingGate, type CeilingGateSpec } from './ceilingGate';
import { armEvidence, evidenceReason, insufficient, safeRate } from './gateEvidence';
import { DIRECT_MEASUREMENT } from './gateGrades';
import { oneArmedMeasurement } from './gateMeasurement';
import type { RampGateEvaluationInput, RampGateResult } from './gateTypes';
import { safeOutcomeCount } from '../../analytics/transportOutcomeSummary';

/**
 * Exported for the decidability assertion in `gates.units.test.ts` only — a
 * ceiling spec that can neither breach an absolute ceiling nor be compared
 * against a second series would pass unconditionally, and that invariant is
 * asserted over every shipped spec rather than merely documented.
 */
export const HARD_BOUNCE_SPEC: CeilingGateSpec = {
	gate: 'hard_bounce',
	rateOf: (summary) => summary.hardBounceRate,
	thresholdOf: (thresholds) => thresholds.hardBounceMax,
	floorOf: (floors) => floors.hardBounce,
	secondSeries: {
		of: (input) => input.reference,
		arm: 'reference',
		maxAgeOf: (thresholds) => thresholds.maxEvidenceAgeMs,
		floorOf: (floors) => floors.hardBounce,
		comparison: {
			kind: 'tolerance_pp',
			of: (t) => t.hardBounceTolerance,
			failReason: 'reference_tolerance_breached',
		},
	},
	grade: DIRECT_MEASUREMENT,
};

/** Exported for the same decidability assertion as `HARD_BOUNCE_SPEC`. */
export const COMPLAINT_SPEC: CeilingGateSpec = {
	gate: 'complaint',
	rateOf: (summary) => summary.complaintRate,
	thresholdOf: (thresholds) => thresholds.complaintMax,
	floorOf: (floors) => floors.complaint,
	secondSeries: {
		of: (input) => input.reference,
		arm: 'reference',
		maxAgeOf: (thresholds) => thresholds.maxEvidenceAgeMs,
		floorOf: (floors) => floors.complaint,
		comparison: {
			kind: 'tolerance_pp',
			of: (t) => t.complaintTolerance,
			failReason: 'reference_tolerance_breached',
		},
	},
	grade: DIRECT_MEASUREMENT,
};

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
	const shape = oneArmedMeasurement({
		thresholdRate: thresholds.deferralMax as number,
		ownSample,
		minSample,
	});

	const evidence = armEvidence(
		input.own,
		ownSample,
		minSample,
		input.now,
		thresholds,
		thresholds.maxEvidenceAgeMs
	);
	if (evidence !== 'fresh' || ownRate === null) {
		return insufficient(
			'deferral',
			evidenceReason(evidence, 'own'),
			{ ...shape, ownRate },
			DIRECT_MEASUREMENT
		);
	}

	if (ownRate >= (thresholds.deferralHalt as number)) {
		return {
			gate: 'deferral',
			status: 'halt',
			reason: 'halt_threshold_breached',
			measurement: { ...shape, ownRate },
			...DIRECT_MEASUREMENT,
		};
	}

	return ownRate <= (thresholds.deferralMax as number)
		? {
				gate: 'deferral',
				status: 'pass',
				reason: 'within_threshold',
				measurement: { ...shape, ownRate },
				...DIRECT_MEASUREMENT,
			}
		: {
				gate: 'deferral',
				status: 'fail',
				reason: 'absolute_threshold_breached',
				measurement: { ...shape, ownRate },
				...DIRECT_MEASUREMENT,
			};
}
