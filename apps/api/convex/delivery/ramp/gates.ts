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
 * `ceilingGate.ts`. Gate 4 (engagement ratio) lives in its own module because of
 * its MPP handling; the aggregator takes it as a pre-computed result. The
 * aggregator itself is in `gateEvaluation.ts`. The "is this evidence usable at
 * all" rules — freshness, clock skew, thin samples, poisoned rates — live in
 * `gateEvidence.ts`, shared with gate 4 so the safety property has exactly one
 * implementation. The confidence grades are in `gateGrades.ts`.
 */

import { evaluateCeilingGate, withinTolerance, type CeilingGateSpec } from './ceilingGate';
import type { PercentagePoints, RampGateThresholds } from './gateConfig';
import {
	armEvidence,
	evidenceFreshness,
	evidenceReason,
	insufficient,
	safeRate,
	type ArmEvidence,
} from './gateEvidence';
import { DIRECT_MEASUREMENT, SEED_TRIPWIRE } from './gateGrades';
import { oneArmedMeasurement } from './gateMeasurement';
import type {
	RampGateEvaluationInput,
	RampGateGrade,
	RampGateResult,
	SeedPlacementObservation,
} from './gateTypes';
import { safeOutcomeCount } from '../../analytics/transportOutcomeSummary';

const HARD_BOUNCE_SPEC: CeilingGateSpec = {
	gate: 'hard_bounce',
	rateOf: (summary) => summary.hardBounceRate,
	thresholdOf: (thresholds) => thresholds.hardBounceMax,
	floorOf: (floors) => floors.hardBounce,
	secondSeries: {
		of: (input) => input.reference,
		arm: 'reference',
		maxAgeOf: (thresholds) => thresholds.maxEvidenceAgeMs,
		floorOf: (floors) => floors.hardBounce,
		comparison: { kind: 'tolerance_pp', of: (t) => t.hardBounceTolerance },
	},
	grade: DIRECT_MEASUREMENT,
};

const COMPLAINT_SPEC: CeilingGateSpec = {
	gate: 'complaint',
	rateOf: (summary) => summary.complaintRate,
	thresholdOf: (thresholds) => thresholds.complaintMax,
	floorOf: (floors) => floors.complaint,
	secondSeries: {
		of: (input) => input.reference,
		arm: 'reference',
		maxAgeOf: (thresholds) => thresholds.maxEvidenceAgeMs,
		floorOf: (floors) => floors.complaint,
		comparison: { kind: 'tolerance_pp', of: (t) => t.complaintTolerance },
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
	return evidenceFreshness(observation.observedAt, now, thresholds, thresholds.maxEvidenceAgeMs);
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
	return evaluateSeedGate(REFERENCE_SEED_SPEC, input);
}

/**
 * Gate 5, STANDALONE: the ABSOLUTE inbox floor only.
 *
 * A deployment with no reference transport has no second seed sweep to compare
 * against, so the comparative half is not "unmeasurable" — it does not exist.
 * Holding on a series that is absent by design would silently delete the gate in
 * exactly the configuration the plan promotes it from optional to RECOMMENDED
 * (P2-6 supplies the data), which is the degraded path rotting in one line.
 *
 * Still a tripwire and still corroboration-required (plan D17): a collapse across
 * 5-10 mailboxes is actionable at any sample size, and a percentage off it is not
 * a number anyone should quote.
 */
export function evaluateStandaloneSeedPlacementGate(
	input: RampGateEvaluationInput
): RampGateResult {
	return evaluateSeedGate(STANDALONE_SEED_SPEC, input);
}

/**
 * The second seed sweep a placement gate compares against, and by how much.
 *
 * Bundled rather than left as two independently-nullable fields, for the reason
 * `CeilingSecondSeries` states: a tolerance with no sweep to apply it to, or a
 * sweep with no tolerance, is a comparison that is not happening described in two
 * contradictory ways.
 */
interface SeedComparison {
	readonly referenceOf: (input: RampGateEvaluationInput) => SeedPlacementObservation | null;
	readonly toleranceOf: (thresholds: RampGateThresholds) => PercentagePoints;
}

interface SeedGateSpec {
	/** `null` for the ABSOLUTE-ONLY gate: a standalone cell has no second sweep. */
	readonly comparison: SeedComparison | null;
	readonly grade: RampGateGrade;
}

const REFERENCE_SEED_SPEC: SeedGateSpec = {
	comparison: {
		referenceOf: (input) => input.referenceSeeds ?? null,
		toleranceOf: (thresholds) => thresholds.seedInboxTolerance,
	},
	grade: SEED_TRIPWIRE,
};

const STANDALONE_SEED_SPEC: SeedGateSpec = { comparison: null, grade: SEED_TRIPWIRE };

function evaluateSeedGate(spec: SeedGateSpec, input: RampGateEvaluationInput): RampGateResult {
	const { thresholds, sampleFloors } = input.config;
	const minSample = sampleFloors.seedPlacement;
	const { comparison } = spec;
	const reference = comparison ? comparison.referenceOf(input) : null;
	const ownRate = seedInboxRate(input.ownSeeds);
	const referenceRate = seedInboxRate(reference);
	const shape = {
		referenceRate,
		thresholdRate: thresholds.seedInboxMin as number,
		toleranceValuePp: comparison ? (comparison.toleranceOf(thresholds) as number) : null,
		ownSample: seedTotal(input.ownSeeds),
		referenceSample: reference ? seedTotal(reference) : null,
		minSample,
	} as const;

	const ownEvidence = seedEvidence(input.ownSeeds, minSample, input.now, thresholds);
	if (ownEvidence !== 'fresh' || ownRate === null) {
		return insufficient(
			'seed_placement',
			evidenceReason(ownEvidence, 'own'),
			{ ...shape, ownRate },
			spec.grade
		);
	}

	if (ownRate < (thresholds.seedInboxMin as number)) {
		return {
			gate: 'seed_placement',
			status: 'fail',
			reason: 'absolute_threshold_breached',
			measurement: { ...shape, ownRate },
			...spec.grade,
		};
	}

	// An absolute-only gate has nothing left to consult: the sweep is fresh, large
	// enough and above the inbox floor, which is the whole check.
	if (comparison === null) {
		return {
			gate: 'seed_placement',
			status: 'pass',
			reason: 'within_threshold',
			measurement: { ...shape, ownRate },
			...spec.grade,
		};
	}

	const referenceEvidence = seedEvidence(reference, minSample, input.now, thresholds);
	if (referenceEvidence !== 'fresh' || referenceRate === null) {
		return insufficient(
			'seed_placement',
			evidenceReason(referenceEvidence, 'reference'),
			{ ...shape, ownRate },
			spec.grade
		);
	}

	const within = withinTolerance(
		ownRate,
		referenceRate,
		comparison.toleranceOf(thresholds),
		'own_must_not_fall_below'
	);
	return within
		? {
				gate: 'seed_placement',
				status: 'pass',
				reason: 'within_threshold',
				measurement: { ...shape, ownRate },
				...spec.grade,
			}
		: {
				gate: 'seed_placement',
				status: 'fail',
				reason: 'reference_tolerance_breached',
				measurement: { ...shape, ownRate },
				...spec.grade,
			};
}
