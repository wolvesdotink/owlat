/**
 * GATE 5 — SEED PLACEMENT: the CONTROLLER'S VIEW of the shared roll-up.
 *
 * THE DIVISION OF LABOUR, stated once and enforced by what this module does not
 * contain:
 *
 *   - `@owlat/shared/seedPlacement` owns the MEASUREMENT. The reached-share
 *     threshold, the reference tolerance, the collapse line, the minimum sample
 *     and the confidence a seed reading carries all live there, beside the
 *     roll-up that applies them; `analytics/seedPlacement.ts` is the Convex
 *     surface that feeds it real probes.
 *   - THIS MODULE owns the TRANSLATION. It restates a `SeedProviderRollup`
 *     STATUS in the controller's `RampGateResult` vocabulary — the freshness and
 *     clock-skew cascade every other ramp gate obeys, the ramp's reason codes,
 *     and the grade the aggregator folds into measurement confidence.
 *
 * IT DECIDES NOTHING OF ITS OWN. No threshold is declared here and no rate is
 * compared against one here: the pass/fail comes out of the roll-up's status.
 * A second home for the 90 % line would be a second answer to "did the seeds
 * reach the inbox", and D5's rule is that the controller and the dashboard must
 * never be able to disagree about a number. The rates in the MEASUREMENT shape
 * are RENDERED, never consulted, and they are counted with the shared module's
 * own `isSeedPlacementReached` predicate so even the displayed number cannot
 * disagree with the verdict beside it.
 *
 * SEEDS ARE A TRIPWIRE, NOT A GAUGE (plan D17). The CORROBORATION RULE is the
 * shared module's (`resolveSeedTripwire`, applied by
 * `analytics.seedPlacement.getGateVerdict`); the ramp only FLAGS a seed fail
 * through `CORROBORATION_REQUIRED_RAMP_GATES` so the controller (P3-2) reaches
 * for that one rule rather than writing a second copy of it.
 *
 * ONE IMPLEMENTATION, NOT TWO. Standalone is the DEGENERATE CASE, exactly as
 * D1's boolean is a degenerate share: with no reference-arm probes the roll-up
 * reports `no_reference_arm` and the absolute clause is the whole gate (D3's
 * substitution). The standalone entry point below is the same function with the
 * reference sweep dropped at the boundary, so the degraded path cannot diverge
 * from the equipped one — there is nothing for it to diverge from.
 *
 * PURE (plan D15): `now` is a parameter, nothing reads a clock, a database or the
 * environment.
 */

import {
	isSeedPlacementReached,
	summarizeSeedProvider,
	type SeedObservation,
	type SeedPlacement,
	type SeedProviderRollup,
	type SeedTransportArm,
} from '@owlat/shared/seedPlacement';
import type { RampGateThresholds } from './gateConfig';
import { evidenceFreshness, evidenceReason, insufficient, type ArmEvidence } from './gateEvidence';
import { SEED_TRIPWIRE } from './gateGrades';
import type {
	RampGateEvaluationInput,
	RampGateResult,
	SeedPlacementObservation,
} from './gateTypes';
import { safeOutcomeCount } from '../../analytics/transportOutcomeSummary';

/**
 * The roll-up is keyed by destination provider; a ramp evaluation is ALREADY
 * scoped to one cell, so that axis is degenerate here and the key is a label
 * rather than a fact. Nothing this module returns carries it.
 */
const CELL_PROVIDER = 'other';

/**
 * A sweep claiming more probes than any deployment has seed mailboxes is a
 * PRODUCER BUG, not a very good measurement (plan D17 — 5-10 mailboxes per
 * provider). Bounded rather than trusted, because the roll-up is fed one
 * observation per probe and an unbounded count is an unbounded allocation.
 */
const MAX_SEED_SWEEP = 1000;

/** The three placements a counted sweep can express, in one place. */
const SWEEP_PLACEMENTS = ['inbox', 'spam', 'missing'] as const satisfies readonly SeedPlacement[];

function sweepCount(
	sweep: SeedPlacementObservation,
	placement: (typeof SWEEP_PLACEMENTS)[number]
): number {
	return safeOutcomeCount(sweep[placement]);
}

function sweepTotal(sweep: SeedPlacementObservation | null | undefined): number {
	if (!sweep) return 0;
	let total = 0;
	for (const placement of SWEEP_PLACEMENTS) total += sweepCount(sweep, placement);
	return total;
}

/**
 * Expand one arm's counted sweep into the observations the shared roll-up
 * consumes. Negative, fractional and non-finite counts are scrubbed by
 * `safeOutcomeCount` before they can become a sample size.
 */
function armObservations(
	sweep: SeedPlacementObservation | null | undefined,
	arm: SeedTransportArm
): SeedObservation[] {
	if (!sweep) return [];
	const observations: SeedObservation[] = [];
	for (const placement of SWEEP_PLACEMENTS) {
		const count = Math.min(sweepCount(sweep, placement), MAX_SEED_SWEEP);
		for (let index = 0; index < count; index += 1) {
			observations.push({ provider: CELL_PROVIDER, arm, placement });
		}
	}
	return observations;
}

/**
 * The RENDERED reached share for one arm, or `null` when the arm has no probes.
 *
 * Display only — no branch in this module compares it to anything. It is
 * counted with the shared module's own `isSeedPlacementReached` so the number
 * beside the verdict is the number the verdict was reached from.
 */
function reachedShare(sweep: SeedPlacementObservation | null | undefined): number | null {
	const total = sweepTotal(sweep);
	if (!sweep || total <= 0) return null;
	let reached = 0;
	for (const placement of SWEEP_PLACEMENTS) {
		if (isSeedPlacementReached(placement)) reached += sweepCount(sweep, placement);
	}
	return Math.min(1, reached / total);
}

/**
 * Freshness is the RAMP's rule, not the roll-up's: every gate holds rather than
 * passing on a stale or future-dated window (plan D9/D10), and the roll-up has
 * no clock. Sample size stays the roll-up's — a sweep it graded
 * `insufficient_data` is thin by the one definition there is.
 */
function sweepFreshness(
	sweep: SeedPlacementObservation | null | undefined,
	now: number,
	thresholds: RampGateThresholds
): ArmEvidence {
	if (!sweep) return 'absent';
	if (sweepTotal(sweep) <= 0) return 'thin';
	return evidenceFreshness(sweep.observedAt, now, thresholds, thresholds.maxEvidenceAgeMs);
}

/**
 * Gate 5 — SEED PLACEMENT (OPTIONAL): the shared roll-up's status, restated.
 *
 * Absent seed data returns `insufficient_data`, NEVER `fail` (plan D2) — and
 * because the gate is listed in `OPTIONAL_RAMP_GATES`, that `insufficient_data`
 * does not hold the ramp either: it only lowers measurement confidence. A
 * deployment with zero seed mailboxes is a supported configuration, not an
 * incomplete setup.
 */
export function evaluateSeedPlacementGate(input: RampGateEvaluationInput): RampGateResult {
	return evaluateSeedGate(input, true);
}

/**
 * Gate 5, STANDALONE: the same gate with no second sweep.
 *
 * A deployment with no reference transport has no reference-arm probes, so the
 * roll-up's comparison clause reports `no_reference_arm` and the absolute clause
 * is the whole gate. The reference sweep is dropped HERE rather than trusted to
 * be absent, for the same reason the standalone evaluator ignores
 * `input.reference`: a caller that wires a relay into the standalone path gets
 * standalone behaviour, not a silent hybrid nobody designed. And it is DROPPED
 * rather than merely unread — a reference sweep left in the roll-up would move
 * the comparison clause off `no_reference_arm` and quietly reinstate the second
 * half of a gate this configuration does not have.
 */
export function evaluateStandaloneSeedPlacementGate(
	input: RampGateEvaluationInput
): RampGateResult {
	return evaluateSeedGate(input, false);
}

function evaluateSeedGate(
	input: RampGateEvaluationInput,
	expectsReference: boolean
): RampGateResult {
	const { thresholds, sampleFloors } = input.config;
	const own = input.ownSeeds ?? null;
	const referenceSweep = expectsReference ? (input.referenceSeeds ?? null) : null;
	const rollup: SeedProviderRollup = summarizeSeedProvider(CELL_PROVIDER, [
		...armObservations(own, 'own'),
		...armObservations(referenceSweep, 'reference'),
	]);

	const ownRate = reachedShare(own);
	const shape = {
		referenceRate: reachedShare(referenceSweep),
		thresholdRate: thresholds.seedInboxMin as number,
		toleranceValuePp: expectsReference ? (thresholds.seedInboxTolerance as number) : null,
		ownSample: rollup.sampleSize,
		referenceSample: expectsReference ? rollup.referenceSampleSize : null,
		minSample: sampleFloors.seedPlacement,
	} as const;

	const ownEvidence = sweepFreshness(own, input.now, thresholds);
	if (ownEvidence !== 'fresh' || rollup.status === 'insufficient_data' || ownRate === null) {
		return insufficient(
			'seed_placement',
			// A fresh sweep the roll-up still graded `insufficient_data` is a sweep
			// with too few probes — the one definition of thin there is.
			evidenceReason(ownEvidence === 'fresh' ? 'thin' : ownEvidence, 'own'),
			{ ...shape, ownRate },
			SEED_TRIPWIRE
		);
	}

	// THE ABSOLUTE CLAUSE FIRST, and before the second sweep is consulted at all —
	// the shipped precedence, so a cell whose own seeds are in the spam folder is
	// told THAT rather than told we could not find a relay to compare it with.
	// `mixed` and `collapse_suspected` are both BELOW the shared reached
	// threshold; the controller's response to either is identical, and which of
	// the two it was is the analytics roll-up's story to tell, not the gate's.
	if (rollup.status !== 'inbox_dominant') {
		return {
			gate: 'seed_placement',
			status: 'fail',
			reason: 'absolute_threshold_breached',
			measurement: { ...shape, ownRate },
			...SEED_TRIPWIRE,
		};
	}

	const pass = (): RampGateResult => ({
		gate: 'seed_placement',
		status: 'pass',
		reason: 'within_threshold',
		measurement: { ...shape, ownRate },
		...SEED_TRIPWIRE,
	});

	// An absolute-only gate has nothing left to consult: the sweep is fresh, large
	// enough and above the inbox floor, which is the whole check.
	if (!expectsReference) return pass();

	const referenceEvidence = sweepFreshness(referenceSweep, input.now, thresholds);
	// A reference sweep that is absent, stale, or too thin to compare against
	// leaves the second clause UNMEASURED. It never fails it.
	if (referenceEvidence !== 'fresh' || rollup.reference === 'insufficient_reference_sample') {
		return insufficient(
			'seed_placement',
			evidenceReason(referenceEvidence === 'fresh' ? 'thin' : referenceEvidence, 'reference'),
			{ ...shape, ownRate },
			SEED_TRIPWIRE
		);
	}

	return rollup.reference === 'below_reference'
		? {
				gate: 'seed_placement',
				status: 'fail',
				reason: 'reference_tolerance_breached',
				measurement: { ...shape, ownRate },
				...SEED_TRIPWIRE,
			}
		: pass();
}
