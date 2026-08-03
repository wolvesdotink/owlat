/**
 * THE SUBSTITUTION FOLD (plan D2, D3, D14) — the one consumer of the matrix.
 *
 * `./degradationMatrix.ts` is the table; this module is the ONLY place that
 * reads it and turns it into the numbers the controller and the dashboard use.
 * Everything here is pure: presence in, a resolution out, no clock, no database,
 * no environment.
 *
 * WHY ONE FOLD AND NOT A HELPER PER INTEGRATION. The failure mode this piece
 * exists to prevent is a substitution that lives in an inline conditional
 * somewhere in the controller. The defence is that there is exactly one function
 * that can produce a degraded constant, it is driven entirely by the table's
 * fields, and it has no branch naming an integration: adding an integration is a
 * table row and nothing else.
 *
 * EVERY FOLD IS COMMUTATIVE AND FAILS TOWARD CAUTION:
 *   - K_CLEAN            — the STRICTEST (largest) override wins.
 *   - step multiplier    — multiplied, so two halvings genuinely quarter it.
 *   - dwell multiplier   — multiplied, for the same reason.
 *   - ceiling delta      — summed, then clamped to the ladder's lowest rung.
 *   - complaint ceiling  — the TIGHTEST (smallest) override wins.
 *   - pace day ceiling   — the LOWEST cap wins.
 *   - confidence         — the WEAKEST applicable entry, via `weakestConfidence`.
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import {
	entryAppliesToProvider,
	RAMP_DEGRADATION_MATRIX,
	COMPLAINT_PROXY_TOLERANCE,
	type RampIntegrationId,
	type RampIntegrationPresence,
	type RampSubstituteSource,
	type RampSubstitutionEntry,
} from './degradationMatrix';
import { RAMP_PHASE_CEILINGS } from './controllerConfig';
import {
	percentagePoints,
	rateFraction,
	type RampStreamConfig,
	type RateFraction,
} from './gateConfig';
import { weakestConfidence } from './gateGrades';
import type { RampGateConfidence } from './gateTypes';

/**
 * WHICH ACTUATOR THIS CELL DRIVES (D3). One controller, two actuators: with a
 * reference transport it writes a SHARE, standalone it writes a warming-PACE
 * multiplier. The choice is read off the table's `substitutes` list rather than
 * from a `hasRelay` boolean, so it is the same substitution mechanism as every
 * other degraded behaviour.
 */
export type RampActuator = 'share' | 'pace';

export interface RampDegradation {
	readonly provider: DestinationProviderKey;
	/** Absent integrations that GOVERN this cell, in table order. */
	readonly absent: readonly RampSubstitutionEntry[];
	readonly substitutes: readonly RampSubstituteSource[];
	readonly actuator: RampActuator;
	/** `undefined` when no entry overrides K_CLEAN — the stream's own value stands. */
	readonly cleanWindowsRequired: number | undefined;
	readonly stepMultiplier: number;
	readonly dwellMultiplier: number;
	readonly ceilingPhaseDelta: number;
	/**
	 * WHICH absent integration lowered the ceiling — the FIRST table entry (in
	 * table order) that contributed a non-zero `ceilingPhaseDelta`, `undefined`
	 * when nothing did.
	 *
	 * Resolved HERE rather than re-derived by whoever renders the sentence,
	 * because the number and the name have to come from one fold: an audit row
	 * that blames an integration the cap did not come from is worse than one that
	 * blames nobody (plan D12).
	 */
	readonly ceilingCappedBy: RampIntegrationId | undefined;
	readonly complaintMaxOverride: RateFraction | undefined;
	/**
	 * The furthest warming-schedule DAY the pace actuator may reach.
	 * CONSUMED BY the pace-actuator piece (P4-4), which is what clamps the warming
	 * schedule; resolved here because it is the substitution table's number and
	 * this is the table's one fold.
	 */
	readonly paceCeilingDay: number | undefined;
	readonly confidence: RampGateConfidence;
	/**
	 * NO `notes` AND NO `improvements` HERE ON PURPOSE. Both are 1:1 projections
	 * of `absent` — two representations of one fact, free to drift — so the copy is
	 * derived where it is rendered, in `./measurementConfidence.ts`, from this list.
	 */
	/** ALWAYS false. Absence never blocks anything (D2). */
	readonly isBlocking: false;
}

/**
 * Resolve the deployment's integration presence into this cell's degraded
 * constants. Total: every presence map and every provider yields a resolution,
 * and the fully-equipped case yields the identity (no multipliers, no overrides).
 */
export function resolveRampDegradation(args: {
	readonly presence: RampIntegrationPresence;
	readonly provider: DestinationProviderKey;
}): RampDegradation {
	const { presence, provider } = args;
	const absent = RAMP_DEGRADATION_MATRIX.filter(
		(entry) => presence[entry.integration] === false && entryAppliesToProvider(entry, provider)
	);

	const substitutes: RampSubstituteSource[] = [];
	let cleanWindowsRequired: number | undefined;
	let stepMultiplier = 1;
	let dwellMultiplier = 1;
	let ceilingPhaseDelta = 0;
	let ceilingCappedBy: RampIntegrationId | undefined;
	let complaintMaxOverride: RateFraction | undefined;
	let paceCeilingDay: number | undefined;
	const confidences: RampGateConfidence[] = [];

	for (const entry of absent) {
		for (const source of entry.substitutes) {
			if (!substitutes.includes(source)) substitutes.push(source);
		}
		if (entry.cleanWindowsRequired !== undefined) {
			cleanWindowsRequired = Math.max(cleanWindowsRequired ?? 0, entry.cleanWindowsRequired);
		}
		if (entry.stepMultiplier !== undefined) stepMultiplier *= entry.stepMultiplier;
		if (entry.dwellMultiplier !== undefined) dwellMultiplier *= entry.dwellMultiplier;
		if (entry.ceilingPhaseDelta !== undefined && entry.ceilingPhaseDelta !== 0) {
			ceilingPhaseDelta += entry.ceilingPhaseDelta;
			ceilingCappedBy ??= entry.integration;
		}
		if (entry.complaintMaxOverride !== undefined) {
			complaintMaxOverride =
				complaintMaxOverride === undefined
					? entry.complaintMaxOverride
					: rateFraction(Math.min(complaintMaxOverride, entry.complaintMaxOverride));
		}
		if (entry.paceCeilingDay !== undefined) {
			paceCeilingDay =
				paceCeilingDay === undefined
					? entry.paceCeilingDay
					: Math.min(paceCeilingDay, entry.paceCeilingDay);
		}
		confidences.push(entry.confidence);
	}

	return {
		provider,
		absent,
		substitutes,
		actuator: substitutes.includes('pace_actuator') ? 'pace' : 'share',
		cleanWindowsRequired,
		stepMultiplier,
		dwellMultiplier,
		ceilingPhaseDelta,
		ceilingCappedBy,
		complaintMaxOverride,
		paceCeilingDay,
		confidence: weakestConfidence(confidences),
		isBlocking: false,
	};
}

/**
 * The stream's ramp constants with this cell's substitutions applied.
 *
 * The equipped resolution returns the base object UNCHANGED — identity, not a
 * copy with the same numbers — so "does degradation change anything here?" is
 * answerable by reference equality in a fixture.
 */
export function degradedStreamConfig(
	base: RampStreamConfig,
	degradation: RampDegradation
): RampStreamConfig {
	const { cleanWindowsRequired, stepMultiplier, complaintMaxOverride } = degradation;
	if (
		cleanWindowsRequired === undefined &&
		stepMultiplier === 1 &&
		complaintMaxOverride === undefined
	) {
		return base;
	}
	const thresholds =
		complaintMaxOverride === undefined
			? base.thresholds
			: {
					...base.thresholds,
					complaintMax: complaintMaxOverride,
					// The tolerance moves with the ceiling it belongs to: a proxy line half
					// as wide judged against the equipped tolerance would let the relative
					// half of the gate pass what the absolute half just failed.
					complaintTolerance: COMPLAINT_PROXY_TOLERANCE,
				};
	return {
		...base,
		cleanWindowsRequired: cleanWindowsRequired ?? base.cleanWindowsRequired,
		increaseStep: percentagePoints((base.increaseStep as number) * stepMultiplier),
		thresholds,
	};
}

/**
 * The highest phase-ceiling rung this cell may occupy, given the substitutions.
 *
 * Applied to the LADDER INDEX rather than to the number, because "one phase
 * lower" is a rung, not a subtraction: 0.8 - 1 is not a ceiling. Never falls
 * below the lowest rung — a capped cell still ramps, just not as far, which is
 * the whole difference between slowing down and halting (D2).
 */
export function degradedCeilingCap(degradation: RampDegradation): number {
	const top = RAMP_PHASE_CEILINGS.length - 1;
	const index = Math.min(top, Math.max(0, top + degradation.ceilingPhaseDelta));
	return RAMP_PHASE_CEILINGS[index] ?? RAMP_PHASE_CEILINGS[0];
}

/**
 * DOES THE PHASE LADDER BIND THIS CELL AT ALL (plan D3)?
 *
 * Both phase bounds — the stored rung and the table's cap on it — govern the
 * SHARE dial, so they bind exactly the cells that have a second sender to hold a
 * share back for. A cell driving the PACE dial has none, and a rung applied to
 * its share would pull mail toward a destination the deployment does not have.
 *
 * ONE PREDICATE, because the tick is not its only reader. `phaseLadderBounds`
 * asks it on every evaluation and `resetCellPhase` asks it before cutting a
 * share to a rung; two `actuator === 'share'` comparisons at two call sites are
 * two chances for the operator's door and the controller's to disagree about
 * which dial a cell is on.
 */
export function bindsPhaseLadder(degradation: RampDegradation): boolean {
	return degradation.actuator === 'share';
}

/**
 * Whether the engagement signal for this cell is the trailing baseline rather
 * than a concurrent second arm. Read off the substitution list, so the evaluator
 * choice is the table's decision and not the call site's.
 */
export function usesTrailingBaseline(degradation: RampDegradation): boolean {
	return degradation.substitutes.includes('trailing_baseline_engagement');
}

/**
 * Whether the complaint gate for this cell is judged from the unsubscribe-rate
 * PROXY rather than from a real feedback loop.
 *
 * The twin of `usesTrailingBaseline`, and it exists for the same reason: the
 * decision path must never read `presence.complaint_feedback_loop` itself. An
 * integration's presence is read exactly once, by the fold, and every consumer
 * asks the RESOLUTION what to do — which is what keeps adding an integration a
 * table row and nothing else (plan D3).
 */
export function usesUnsubscribeProxy(degradation: RampDegradation): boolean {
	return degradation.substitutes.includes('unsubscribe_rate_proxy');
}
