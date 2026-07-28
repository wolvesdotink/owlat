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
		if (entry.ceilingPhaseDelta !== undefined) ceilingPhaseDelta += entry.ceilingPhaseDelta;
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
 * Whether the engagement signal for this cell is the trailing baseline rather
 * than a concurrent second arm. Read off the substitution list, so the evaluator
 * choice is the table's decision and not the call site's.
 */
export function usesTrailingBaseline(degradation: RampDegradation): boolean {
	return degradation.substitutes.includes('trailing_baseline_engagement');
}
