/**
 * Seed placement — THE CORROBORATION RULE AND GATE 5 (plan D17, D10, D14).
 *
 * A domain sibling of `seedPlacementGate.ts` (CONVENTIONS' ~500 LOC guideline):
 * that module owns the MEASUREMENT — what a set of probes says about one
 * provider — and this one owns what the controller is allowed to DO about it.
 *
 * The seam is the `SeedProviderRollup`. Nothing here re-reads a probe, and
 * nothing here declares a threshold: the reached line, the collapse line, the
 * reference tolerance and the minimum sample all stay in the sibling, beside the
 * roll-up that applies them. This file only turns a status into a verdict.
 *
 * Re-exported from `seedPlacement.ts`, which stays the one import surface.
 *
 * Pure: no clock, no I/O, every input a parameter (D15).
 */

import type { DestinationProviderKey } from './deliverabilityRouting';
import {
	SEED_GATE_CONFIDENCE,
	type SeedConfidence,
	type SeedProviderRollup,
} from './seedPlacementGate';

/**
 * The other two outcome gates' current readings. A seed collapse across eight
 * mailboxes is not, on its own, permitted to halve a healthy deployment's
 * share — a real placement collapse shows up in deferrals or bounces too.
 */
export interface SeedCorroboration {
	deferralGateBreached: boolean;
	bounceGateBreached: boolean;
}

/**
 * What a provider's reading MEANS to the controller, as a discriminated union.
 *
 * The discriminant, not the reason string, is what the gate switches on. An
 * earlier shape carried `action: 'hold' | 'act'` and left the gate to re-derive
 * "is this hold a suspicion?" by matching a subset of the reason literals — and
 * a hold whose reason was not in that subset silently read as CLEAN. That is
 * exactly how a below-threshold provider came to license an increase. With
 * three distinct outcomes the only way to count a provider as clean is to
 * return `clean`, so the mistake is not available.
 *
 *   - `act`      — a suspicion the deferral or bounce gate CORROBORATES: fail.
 *   - `suspect`  — a suspicion nothing corroborates: HOLD (never a pass, and
 *                  never a decrease either).
 *   - `clean`    — gate 5's clauses are satisfied. The only pass.
 *   - `insufficient` — below the minimum sample; no verdict in any direction.
 */
export type SeedTripwireOutcome = 'act' | 'suspect' | 'clean' | 'insufficient';

/** Suspicions: a reason to doubt with nothing yet confirming it. */
export type SeedSuspicionReason =
	| 'seeds_below_reached_threshold_awaiting_corroboration'
	| 'seed_probes_missing_awaiting_corroboration'
	| 'seed_collapse_awaiting_corroboration'
	| 'seeds_below_reference_awaiting_corroboration';

/** The same four suspicions, corroborated by the deferral or the bounce gate. */
export type SeedCorroboratedReason =
	| 'seeds_below_reached_threshold_corroborated'
	| 'seed_probes_missing_corroborated'
	| 'seed_collapse_corroborated'
	| 'seeds_below_reference_corroborated';

export type SeedTripwireResolution =
	| { outcome: 'insufficient'; reason: 'insufficient_seed_sample' }
	| { outcome: 'clean'; reason: 'seeds_reaching_inbox' }
	| { outcome: 'suspect'; reason: SeedSuspicionReason }
	| { outcome: 'act'; reason: SeedCorroboratedReason };

export function resolveSeedTripwire(
	rollup: SeedProviderRollup,
	corroboration: SeedCorroboration
): SeedTripwireResolution {
	const corroborated = corroboration.deferralGateBreached || corroboration.bounceGateBreached;
	const gated = (
		corroboratedReason: SeedCorroboratedReason,
		awaitingReason: SeedSuspicionReason
	): SeedTripwireResolution =>
		corroborated
			? { outcome: 'act', reason: corroboratedReason }
			: { outcome: 'suspect', reason: awaitingReason };
	/** Two call sites (the `mixed` and `inbox_dominant` branches). */
	const belowReference = (): SeedTripwireResolution =>
		gated('seeds_below_reference_corroborated', 'seeds_below_reference_awaiting_corroboration');

	switch (rollup.status) {
		case 'insufficient_data':
			return { outcome: 'insufficient', reason: 'insufficient_seed_sample' };
		case 'collapse_suspected':
			return gated('seed_collapse_corroborated', 'seed_collapse_awaiting_corroboration');
		case 'mixed':
			// D17 calls MISSING the most alarming outcome and the one no other
			// signal surfaces at all — so a degraded provider that is also LOSING
			// probes is named for what it is, behind the same corroboration gate a
			// collapse sits behind.
			if (rollup.anyMissing) {
				return gated(
					'seed_probes_missing_corroborated',
					'seed_probes_missing_awaiting_corroboration'
				);
			}
			// Gate 5's SECOND clause. Behind the same corroboration gate as the
			// first: a seed reading is a tripwire whichever clause trips it.
			if (rollup.reference === 'below_reference') return belowReference();
			// GATE 5'S FIRST CLAUSE, ENFORCED. `mixed` is BELOW
			// SEED_REACHED_THRESHOLD by construction — a material share of every
			// probe is being filed to spam, binned, or lost — so it is a suspicion,
			// never a clean reading. Reporting it clean is what let the controller
			// count the gate towards the K_CLEAN streak and ramp the share UP while
			// the seeds said the opposite, and standalone (where there is no
			// reference arm and this clause IS the whole gate, D3) it was the only
			// clause left. Uncorroborated it HOLDS, exactly like a collapse.
			return gated(
				'seeds_below_reached_threshold_corroborated',
				'seeds_below_reached_threshold_awaiting_corroboration'
			);
		case 'inbox_dominant':
			// Above SEED_REACHED_THRESHOLD the provider is healthy enough that a
			// single stray disappearance is noise, not a signal — but the reference
			// arm can still be doing measurably better, which is the comparison the
			// plan's second clause exists to make.
			if (rollup.reference === 'below_reference') return belowReference();
			return { outcome: 'clean', reason: 'seeds_reaching_inbox' };
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
		switch (resolution.outcome) {
			case 'act':
				failedProviders.push(rollup.provider);
				break;
			case 'suspect':
				suspectProviders.push(rollup.provider);
				break;
			case 'clean':
			case 'insufficient':
				// `insufficient` cannot reach here (those rollups are filtered above),
				// and `clean` is the ONLY reading that contributes to a pass — by
				// contributing nothing to either list.
				break;
		}
	}

	if (failedProviders.length > 0) {
		return {
			verdict: 'fail',
			reason: `seed_tripwire_corroborated:${failedProviders.join(',')}`,
			confidence: SEED_GATE_CONFIDENCE,
			failedProviders,
			suspectProviders,
		};
	}

	// AN UNCORROBORATED SUSPICION IS NOT A PASS.
	//
	// D17 is right that it may not ACT — eight consumer mailboxes may not halve a
	// healthy deployment's share on their own. But `pass` is not the neutral
	// answer it looks like: the controller counts a passing gate towards the
	// K_CLEAN streak that authorises an additive increase, so reading `pass` here
	// would let the share ramp UP while the seed mailboxes are being filtered to
	// spam. `insufficient_data` is the correct verdict for "we have a reason to
	// doubt and nothing that confirms it": it HOLDS, moving the share neither up
	// nor down, which is also D14's rule that a weak signal may never be the sole
	// basis for an increase.
	if (suspectProviders.length > 0) {
		return {
			verdict: 'insufficient_data',
			reason: `seed_tripwire_awaiting_corroboration:${suspectProviders.join(',')}`,
			confidence: SEED_GATE_CONFIDENCE,
			failedProviders: [],
			suspectProviders,
		};
	}

	return {
		verdict: 'pass',
		reason: 'seeds_reaching_inbox',
		confidence: SEED_GATE_CONFIDENCE,
		failedProviders: [],
		suspectProviders,
	};
}
