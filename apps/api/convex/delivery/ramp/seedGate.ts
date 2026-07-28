/**
 * GATE 5 — SEED PLACEMENT: one cascade, two specs (plan D2, D15, D17).
 *
 * The same shape `ceilingGate.ts` has for gates 1 and 3, for the same reason:
 * the reference-arm implementation and the standalone one differ only in WHICH
 * SECOND SWEEP there is to compare against, so the safety cascade lives here
 * exactly once and the difference is data.
 *
 * IT LIVES IN ITS OWN MODULE so that "where does the standalone implementation
 * live" has ONE answer. The standalone entry point is re-exported from
 * `trailingBaselineGates.ts` beside its four siblings; nothing has to know that
 * the cascade it shares with the reference-arm gate sits here.
 *
 * SEEDS ARE A TRIPWIRE, NOT A GAUGE (plan D17). Five to ten mailboxes is not a
 * sample anyone should quote a percentage from, so what is consumed is the
 * VERDICT, with the sample carried beside it. Both specs are listed in
 * `CORROBORATION_REQUIRED_RAMP_GATES` for that reason.
 *
 * PURE (plan D15): `now` is a parameter, nothing reads a clock, a database or the
 * environment.
 */

import { withinTolerance } from './ceilingGate';
import type { PercentagePoints, RampGateThresholds } from './gateConfig';
import { evidenceFreshness, evidenceReason, insufficient, type ArmEvidence } from './gateEvidence';
import { SEED_TRIPWIRE } from './gateGrades';
import type {
	RampGateEvaluationInput,
	RampGateGrade,
	RampGateResult,
	SeedPlacementObservation,
} from './gateTypes';
import { safeOutcomeCount } from '../../analytics/transportOutcomeSummary';

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

/**
 * Gate 5 — SEED PLACEMENT (OPTIONAL): inbox >= 90% AND >= reference - 5pp.
 *
 * Absent seed data returns `insufficient_data`, NEVER `fail` (plan D2) — and
 * because the gate is listed in `OPTIONAL_RAMP_GATES`, that `insufficient_data`
 * does not hold the ramp either: it only lowers measurement confidence. A
 * deployment with zero seed mailboxes is a supported configuration, not an
 * incomplete setup.
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
