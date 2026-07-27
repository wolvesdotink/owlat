/**
 * Seed placement — the ROLL-UP, the corroboration rule, and gate 5.
 *
 * Split out of `seedPlacement.ts` purely for size (CONVENTIONS' ~500 LOC
 * guideline); `@owlat/shared/seedPlacement` re-exports everything here, so it
 * stays the one import surface and no caller has to know about the seam.
 *
 * D17 — A TRIPWIRE, NOT A GAUGE. Nothing this module returns is a placement
 * percentage: the roll-up is a STATUS per mailbox provider, the reference-arm
 * comparison is a STATUS, and `sampleSize` counts OBSERVATIONS rather than
 * measuring placement. A provider-wide collapse is SUSPECT until the deferral
 * or the bounce gate corroborates it — and uncorroborated it HOLDS the gate
 * (`insufficient_data`) rather than passing it, because a pass would feed the
 * clean streak that authorises an increase.
 *
 * GATE 5 IS TWO CLAUSES, per the plan's signal table: the own arm's reached
 * share must clear `SEED_REACHED_THRESHOLD` AND, when a reference transport
 * carried probes of its own, sit within `SEED_REFERENCE_TOLERANCE` of it.
 * Standalone there is no reference arm and the absolute clause is the whole
 * gate (D3's substitution).
 *
 * Pure: no clock, no I/O, every input a parameter (D15).
 */

import type { DestinationProviderKey } from './deliverabilityRouting';
import { isSeedPlacementReached, type SeedPlacement } from './seedPlacementFolders';

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
 * below it the provider reads `mixed`, which — unlike `inbox_dominant` — can
 * act once corroborated if any probe is also MISSING.
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
 * What a seed reading is worth. D14/D17 — say the quiet part out loud: seeds
 * are never high confidence, so the only values are `none` and `low`.
 */
export type SeedConfidence = 'none' | 'low';

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
 * per-placement count: `sampleSize` is the number of MAILBOXES observed (the
 * honesty input for `insufficient_data`), not a placement measurement. The UI
 * and the controller both read `status` (and `reference`).
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

export function summarizeSeedProvider(
	provider: DestinationProviderKey,
	observations: readonly SeedObservation[]
): SeedProviderRollup {
	const mine = observations.filter((o) => o.provider === provider);
	const own = readArm(mine.filter((o) => o.arm === 'own'));
	const reference = readArm(mine.filter((o) => o.arm === 'reference'));

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
		confidence: 'low',
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

// ============ THE CORROBORATION RULE (D17) ============

/**
 * The other two outcome gates' current readings. A seed collapse across eight
 * mailboxes is not, on its own, permitted to halve a healthy deployment's
 * share — a real placement collapse shows up in deferrals or bounces too.
 */
export interface SeedCorroboration {
	deferralGateBreached: boolean;
	bounceGateBreached: boolean;
}

export type SeedTripwireAction = 'hold' | 'act';

export interface SeedTripwireResolution {
	action: SeedTripwireAction;
	reason:
		| 'insufficient_seed_sample'
		| 'seeds_reaching_inbox'
		| 'seeds_mixed_no_collapse'
		| 'seed_probes_missing_awaiting_corroboration'
		| 'seed_probes_missing_corroborated'
		| 'seed_collapse_awaiting_corroboration'
		| 'seed_collapse_corroborated'
		| 'seeds_below_reference_awaiting_corroboration'
		| 'seeds_below_reference_corroborated';
}

/** True for every reason that is a suspicion the corroboration gate is holding. */
function isAwaitingSeedCorroboration(reason: SeedTripwireResolution['reason']): boolean {
	return (
		reason === 'seed_collapse_awaiting_corroboration' ||
		reason === 'seed_probes_missing_awaiting_corroboration' ||
		reason === 'seeds_below_reference_awaiting_corroboration'
	);
}

export function resolveSeedTripwire(
	rollup: SeedProviderRollup,
	corroboration: SeedCorroboration
): SeedTripwireResolution {
	const corroborated = corroboration.deferralGateBreached || corroboration.bounceGateBreached;
	const gated = (
		corroboratedReason: SeedTripwireResolution['reason'],
		awaitingReason: SeedTripwireResolution['reason']
	): SeedTripwireResolution =>
		corroborated
			? { action: 'act', reason: corroboratedReason }
			: { action: 'hold', reason: awaitingReason };
	const collapse = (): SeedTripwireResolution =>
		gated('seed_collapse_corroborated', 'seed_collapse_awaiting_corroboration');
	const probesMissing = (): SeedTripwireResolution =>
		gated('seed_probes_missing_corroborated', 'seed_probes_missing_awaiting_corroboration');
	const belowReference = (): SeedTripwireResolution =>
		gated('seeds_below_reference_corroborated', 'seeds_below_reference_awaiting_corroboration');

	switch (rollup.status) {
		case 'insufficient_data':
			return { action: 'hold', reason: 'insufficient_seed_sample' };
		case 'collapse_suspected':
			return collapse();
		case 'mixed':
			// D17 calls MISSING the most alarming outcome and the one no other
			// signal surfaces at all — so a degraded provider that is also LOSING
			// probes is actionable, behind the same corroboration gate a collapse
			// sits behind. Degradation without disappearance stays a hold.
			if (rollup.anyMissing) return probesMissing();
			// Gate 5's SECOND clause. Behind the same corroboration gate as the
			// first: a seed reading is a tripwire whichever clause trips it.
			if (rollup.reference === 'below_reference') return belowReference();
			return { action: 'hold', reason: 'seeds_mixed_no_collapse' };
		case 'inbox_dominant':
			// Above SEED_REACHED_THRESHOLD the provider is healthy enough that a
			// single stray disappearance is noise, not a signal — but the reference
			// arm can still be doing measurably better, which is the comparison the
			// plan's second clause exists to make.
			if (rollup.reference === 'below_reference') return belowReference();
			return { action: 'hold', reason: 'seeds_reaching_inbox' };
	}
}

// ============ GATE 5 ============

export type SeedGateVerdict = 'pass' | 'fail' | 'insufficient_data';

export interface SeedGateResult {
	verdict: SeedGateVerdict;
	reason: string;
	confidence: SeedConfidence;
	/** Providers whose collapse is corroborated — the human-readable "what broke". */
	failedProviders: DestinationProviderKey[];
	/**
	 * Providers sitting on an UNcorroborated suspicion. Never acted on (no
	 * decrease), and never counted as clean either — their presence turns the
	 * verdict into `insufficient_data`, which HOLDS.
	 */
	suspectProviders: DestinationProviderKey[];
}

/**
 * Gate 5 of the AIMD controller. With no seed mailboxes connected — the
 * default for a fresh install — this returns `insufficient_data` and the
 * controller HOLDS (D10): the gate can neither advance nor retreat the share.
 */
export function evaluateSeedPlacementGate(input: {
	rollups: readonly SeedProviderRollup[];
	corroboration: SeedCorroboration;
}): SeedGateResult {
	const usable = input.rollups.filter((r) => r.status !== 'insufficient_data');
	if (usable.length === 0) {
		return {
			verdict: 'insufficient_data',
			reason:
				input.rollups.length === 0 ? 'no_seed_mailboxes_connected' : 'insufficient_seed_sample',
			confidence: 'none',
			failedProviders: [],
			suspectProviders: [],
		};
	}

	const failedProviders: DestinationProviderKey[] = [];
	const suspectProviders: DestinationProviderKey[] = [];
	for (const rollup of usable) {
		const resolution = resolveSeedTripwire(rollup, input.corroboration);
		if (resolution.action === 'act') failedProviders.push(rollup.provider);
		else if (isAwaitingSeedCorroboration(resolution.reason)) {
			suspectProviders.push(rollup.provider);
		}
	}

	if (failedProviders.length > 0) {
		return {
			verdict: 'fail',
			reason: `seed_collapse_corroborated:${failedProviders.join(',')}`,
			confidence: 'low',
			failedProviders,
			suspectProviders,
		};
	}

	// An UNCORROBORATED collapse is not a pass.
	//
	// D17 is right that it may not ACT — eight consumer mailboxes may not halve a
	// healthy deployment's share on their own. But `pass` is not the neutral
	// answer it looks like: the controller counts a passing gate towards the
	// K_CLEAN streak that authorises an additive increase, so reading `pass` here
	// would let the share ramp UP while every seed mailbox is being filtered to
	// spam. `insufficient_data` is the correct verdict for "we have a reason to
	// doubt and nothing that confirms it": it HOLDS, moving the share neither up
	// nor down, which is also D14's rule that a weak signal may never be the sole
	// basis for an increase.
	if (suspectProviders.length > 0) {
		return {
			verdict: 'insufficient_data',
			reason: `seed_collapse_awaiting_corroboration:${suspectProviders.join(',')}`,
			confidence: 'low',
			failedProviders: [],
			suspectProviders,
		};
	}

	return {
		verdict: 'pass',
		reason: 'seeds_reaching_inbox',
		confidence: 'low',
		failedProviders: [],
		suspectProviders,
	};
}
