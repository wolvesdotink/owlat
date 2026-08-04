/**
 * Seed placement — THE ROLL-UP (the measurement).
 *
 * Split out of `seedPlacement.ts` purely for size (CONVENTIONS' ~500 LOC
 * guideline); `@owlat/shared/seedPlacement` re-exports everything here, so it
 * stays the one import surface and no caller has to know about the seam.
 * `seedPlacementTripwire.ts` is the sibling on the other side of the
 * `SeedProviderRollup`: it owns the corroboration rule and gate 5's verdict —
 * what the controller may DO about a reading — while every threshold that
 * PRODUCES a reading stays here.
 *
 * D17 — A TRIPWIRE, NOT A GAUGE. Nothing this module returns is a placement
 * percentage: the roll-up is a STATUS per mailbox provider, the reference-arm
 * comparison is a STATUS, and `sampleSize` counts OBSERVATIONS rather than
 * measuring placement.
 *
 * GATE 5 IS TWO CLAUSES, per the plan's signal table: the own arm's reached
 * share must clear `SEED_REACHED_THRESHOLD` AND, when a reference transport
 * carried probes of its own, sit within `SEED_REFERENCE_TOLERANCE` of it.
 * Standalone there is no reference arm and the absolute clause is the whole
 * gate (D3's substitution).
 *
 * THE DIVISION OF LABOUR, because gate 5 has exactly one implementation and it
 * is this one:
 *
 *   - THIS MODULE (with its tripwire sibling) owns the MEASUREMENT: the
 *     per-provider roll-up, the thresholds and the tolerance that turn probes
 *     into a STATUS, the minimum sample, and the confidence a seed reading
 *     carries (`SEED_GATE_CONFIDENCE`).
 *     `analytics/seedPlacement.getGateVerdict` is the Convex surface that feeds
 *     it real probes.
 *   - `delivery/ramp/seedGate.ts` owns the TRANSLATION: it consumes the
 *     `SeedProviderRollup` statuses produced here and restates them in the
 *     controller's `RampGateResult` vocabulary (freshness cascade, reason
 *     codes, the aggregator's precedence). It derives NO rate of its own and
 *     declares NO threshold of its own — a second home for the 90 % line is a
 *     second answer to "did the seeds reach the inbox", and the controller and
 *     the dashboard must never be able to disagree about a number (ADR-0042).
 *
 * Pure: no clock, no I/O, every input a parameter (D15).
 */

import type { DestinationProviderKey } from './deliverabilityRouting';
import {
	SEED_PLACEMENTS,
	isSeedPlacementReached,
	type SeedPlacement,
} from './seedPlacementFolders';

// ============ ROLL-UP (STATUS, NEVER A NUMBER) ============

/**
 * Which transport actually carried the shadow copy. The controller's own arm is
 * the thing under measurement; the reference arm (a relay/ESP, when one is
 * connected) is the yardstick gate 5's second clause compares against.
 *
 * A probe with no recorded arm is read as `own`: standalone is the default
 * configuration, and s === 1 means every probe went through our own MTA.
 */
export type SeedTransportArm = 'own' | 'reference';

export interface SeedObservation {
	provider: DestinationProviderKey;
	arm: SeedTransportArm;
	placement: SeedPlacement;
}

/**
 * Below this many classified probes for a provider the roll-up refuses to
 * render a verdict at all (D10 — `insufficient_data` HOLDS; it never nudges a
 * decision in either direction).
 */
export const SEED_MIN_OBSERVATIONS = 3;

/**
 * Share of probes that must reach the inbox or a tab for a provider to read
 * healthy. This is the plan's gate-5 first clause verbatim (`inbox >= 90 %`);
 * below it the provider reads `mixed`, which is a SUSPICION rather than a clean
 * reading: it holds the gate uncorroborated and fails it once the deferral or
 * the bounce gate corroborates. Only `inbox_dominant` ever passes.
 *
 * Exported so the fixtures pin the CONSTANT rather than a copy of its value.
 */
export const SEED_REACHED_THRESHOLD = 0.9;

/**
 * Below this share of reached probes the provider reads as a COLLAPSE.
 *
 * Derived, not invented: D17's collapse is "mostly-inbox → mostly-spam", and
 * "mostly spam" is exactly "a MAJORITY of probes did not reach" — so the
 * threshold is one half and the comparison is strict. Nothing else is tuned
 * here; the corroboration gate in front of the tripwire, not a cleverer
 * detector, is what protects the eight-mailbox case from acting on noise.
 */
export const SEED_COLLAPSE_THRESHOLD = 0.5;

/**
 * Gate 5's SECOND clause (`>= ref - 5 pp`): how far the own arm's reached share
 * may sit below the reference arm's before the comparison reads as a breach.
 * Only meaningful when a reference transport is connected and carried enough
 * probes of its own; standalone there is nothing to compare against, and the
 * absolute clause is the whole gate (D3's substitution).
 */
export const SEED_REFERENCE_TOLERANCE = 0.05;

export type SeedPlacementStatus =
	/** Fewer than SEED_MIN_OBSERVATIONS classified probes — no verdict. */
	| 'insufficient_data'
	/** Effectively everything reached the inbox or a tab. */
	| 'inbox_dominant'
	/** Some probes are being filtered to spam, binned, or vanishing. */
	| 'mixed'
	/** MOSTLY not reaching: a provider-wide collapse. SUSPECT until corroborated. */
	| 'collapse_suspected';

/**
 * WHAT A SEED READING IS WORTH — ONE ANSWER, ONE HOME.
 *
 * The plan's "gates, degraded honestly" table grades gate 5 MEDIUM: a small
 * sample, but a DIRECT observation of the spam folder rather than a proxy for
 * one. That grade is declared here, beside the thresholds that produce the
 * reading, and the controller's gate-5 result imports it (`SEED_TRIPWIRE` in
 * `delivery/ramp/gateGrades.ts`) instead of restating it — two spellings of one
 * confidence level is two different sentences on one screen.
 *
 * `none` is not a weaker grade, it is the ABSENCE of one: below the minimum
 * sample there is no reading to grade (D10 — insufficient_data HOLDS).
 */
export const SEED_GATE_CONFIDENCE = 'medium';

export type SeedConfidence = 'none' | typeof SEED_GATE_CONFIDENCE;

/**
 * The own arm's standing against the reference arm — gate 5's second clause,
 * rendered as a STATUS. The underlying comparison is arithmetic on two shares,
 * but neither share leaves this module: D17 forbids quoting a placement number,
 * and "we are behind the relay" is the whole of what a caller needs.
 */
export type SeedReferenceStatus =
	/** No reference transport carried probes at all — the standalone default. */
	| 'no_reference_arm'
	/** A reference arm exists but has not carried enough probes to compare. */
	| 'insufficient_reference_sample'
	| 'at_or_above_reference'
	| 'below_reference';

/**
 * The per-provider roll-up. Deliberately carries NO rate, percentage, or
 * per-placement count: `sampleSize` is the number of OBSERVATIONS (the honesty
 * input for `insufficient_data`), not a placement measurement. The UI and the
 * controller both read `status` (and `reference`).
 *
 * AN OBSERVATION IS NOT A MAILBOX, and the distinction is load-bearing wherever
 * the number is rendered. On the shipped source an observation is one PROBE:
 * `seedShadowCopy.ts` writes one shadow copy per connected seed mailbox per
 * send, so eight seed mailboxes across ten campaign sends in the window is a
 * sample of eighty. Both entry points count that way — `readArm` counts
 * observations and `readArmCounts` sums per-placement probe counts — and a
 * commercial panel reports per mailbox per report, which `placementAdapter.ts`
 * expands into the same observations. The unit is always what was OBSERVED,
 * never what is connected.
 *
 * `status`, `sampleSize` and `anyMissing` all describe the OWN arm. Pooling the
 * two arms would let reference-arm probes landing fine dilute an own-arm
 * degradation — which is precisely the failure gate 5 exists to catch.
 */
export interface SeedProviderRollup {
	provider: DestinationProviderKey;
	status: SeedPlacementStatus;
	sampleSize: number;
	confidence: SeedConfidence;
	/** True when at least one OWN-arm probe could not be found in ANY folder. */
	anyMissing: boolean;
	/** Gate 5's second clause as a status. */
	reference: SeedReferenceStatus;
	/** Reference-arm probes observed in the window. Never a placement measure. */
	referenceSampleSize: number;
}

interface ArmReading {
	sampleSize: number;
	reachedShare: number;
	anyMissing: boolean;
}

function readArm(observations: readonly SeedObservation[]): ArmReading {
	const sampleSize = observations.length;
	if (sampleSize === 0) return { sampleSize: 0, reachedShare: 0, anyMissing: false };
	const reached = observations.filter((o) => isSeedPlacementReached(o.placement)).length;
	return {
		sampleSize,
		reachedShare: reached / sampleSize,
		anyMissing: observations.some((o) => o.placement === 'missing'),
	};
}

/**
 * Per-placement PROBE COUNTS for one arm — the same evidence as a
 * `SeedObservation[]`, in the form a caller that already has counters holds it.
 *
 * Omitted placements are zero. Negative, fractional and non-finite counts are
 * scrubbed rather than trusted: a sample size is the one number the
 * `insufficient_data` rule turns on, so it may never be a caller's typo.
 */
export type SeedArmPlacementCounts = Partial<Readonly<Record<SeedPlacement, number>>>;

function safeProbeCount(value: number | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

function readArmCounts(counts: SeedArmPlacementCounts | null | undefined): ArmReading {
	let sampleSize = 0;
	let reached = 0;
	let anyMissing = false;
	for (const placement of SEED_PLACEMENTS) {
		const count = safeProbeCount(counts?.[placement]);
		if (count <= 0) continue;
		sampleSize += count;
		if (isSeedPlacementReached(placement)) reached += count;
		if (placement === 'missing') anyMissing = true;
	}
	if (sampleSize === 0) return { sampleSize: 0, reachedShare: 0, anyMissing: false };
	return { sampleSize, reachedShare: reached / sampleSize, anyMissing };
}

/**
 * The roll-up from COUNTS rather than from one object per probe.
 *
 * THE SAME MEASUREMENT, NOT A SECOND ONE. Both entry points reduce their input
 * to the same `ArmReading` pair and hand it to the same `rollupFromArms`, so the
 * thresholds, the minimum sample and the confidence keep the single home this
 * module gives them. A caller that already counts its probes (the ramp's gate 5
 * holds one integer per placement per arm) can ask its question without first
 * expanding those integers into thousands of throwaway objects for this module
 * to count back down again.
 */
export function summarizeSeedProviderCounts(
	provider: DestinationProviderKey,
	arms: {
		readonly own?: SeedArmPlacementCounts | null;
		readonly reference?: SeedArmPlacementCounts | null;
	}
): SeedProviderRollup {
	return rollupFromArms(provider, readArmCounts(arms.own), readArmCounts(arms.reference));
}

export function summarizeSeedProvider(
	provider: DestinationProviderKey,
	observations: readonly SeedObservation[]
): SeedProviderRollup {
	const mine = observations.filter((o) => o.provider === provider);
	return rollupFromArms(
		provider,
		readArm(mine.filter((o) => o.arm === 'own')),
		readArm(mine.filter((o) => o.arm === 'reference'))
	);
}

function rollupFromArms(
	provider: DestinationProviderKey,
	own: ArmReading,
	reference: ArmReading
): SeedProviderRollup {
	// The comparison needs BOTH arms to clear the minimum sample; below it the
	// second clause holds rather than guessing (D10 — insufficient_data HOLDS).
	const referenceStatus: SeedReferenceStatus =
		reference.sampleSize === 0
			? 'no_reference_arm'
			: reference.sampleSize < SEED_MIN_OBSERVATIONS || own.sampleSize < SEED_MIN_OBSERVATIONS
				? 'insufficient_reference_sample'
				: own.reachedShare >= reference.reachedShare - SEED_REFERENCE_TOLERANCE
					? 'at_or_above_reference'
					: 'below_reference';

	if (own.sampleSize < SEED_MIN_OBSERVATIONS) {
		return {
			provider,
			status: 'insufficient_data',
			sampleSize: own.sampleSize,
			confidence: 'none',
			anyMissing: own.anyMissing,
			reference: referenceStatus,
			referenceSampleSize: reference.sampleSize,
		};
	}

	const status: SeedPlacementStatus =
		own.reachedShare < SEED_COLLAPSE_THRESHOLD
			? 'collapse_suspected'
			: own.reachedShare >= SEED_REACHED_THRESHOLD
				? 'inbox_dominant'
				: 'mixed';

	return {
		provider,
		status,
		sampleSize: own.sampleSize,
		confidence: SEED_GATE_CONFIDENCE,
		anyMissing: own.anyMissing,
		reference: referenceStatus,
		referenceSampleSize: reference.sampleSize,
	};
}

export function summarizeSeedPlacement(
	observations: readonly SeedObservation[]
): SeedProviderRollup[] {
	const providers = new Set<DestinationProviderKey>();
	for (const observation of observations) providers.add(observation.provider);
	return [...providers].map((provider) => summarizeSeedProvider(provider, observations));
}
