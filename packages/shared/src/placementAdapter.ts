/**
 * Placement adapter — ONE interface, exactly TWO implementations (P4-7).
 *
 * P2-6 shipped the self-hosted seed-mailbox placement probe and gate 5 on top
 * of it. This module generalises the SOURCE of that evidence behind a small
 * adapter so a deployment that pays for a commercial placement API can feed the
 * SAME gate without a second tripwire implementation:
 *
 *   - `selfHostedSeedPlacementAdapter` — seed mailboxes. THE DEFAULT AND THE
 *     EXPECTED CONFIGURATION.
 *   - `commercialPlacementApiAdapter` — a commercial panel. STRICTLY AN
 *     UPGRADE.
 *
 * TWO implementations, not N (D20 — Speculative Generality is blocking): there
 * is no registry, no dynamic discovery, no `register()` hook. The union of
 * evidence shapes is CLOSED and lives here; adding a third source would mean
 * editing this file, which is exactly the friction we want.
 *
 * D2 — THE ADDITIVE-ONLY THIRD-PARTY RULE. The commercial key is optional and
 * its absence changes NOTHING: the substitution table for this signal says "no
 * change", because seeds are the expected configuration rather than a degraded
 * one. Nothing here throws, blocks a send, blocks a phase promotion, or renders
 * an error state. The only thing an absent SOURCE can do is leave gate 5 with
 * `insufficient_data`, which HOLDS the controller (D10).
 *
 * D17 — the reading is a TRIPWIRE, not a gauge. The commercial adapter reports
 * mailbox COUNTS and is folded into the same `SeedObservation` roll-up as the
 * seeds, so neither source can produce a placement percentage and the two can
 * never disagree about what "collapse" means.
 *
 * Pure: no clock, no I/O, no env reads — every input is a parameter (D15).
 */

import type { DestinationProviderKey } from './deliverabilityRouting';
import type {
	SeedConfidence,
	SeedObservation,
	SeedPlacement,
	SeedProviderRollup,
	SeedTransportArm,
} from './seedPlacement';
import {
	SEED_ACCOUNTS_PER_ORG_LIMIT,
	SEED_GATE_CONFIDENCE,
	summarizeSeedPlacement,
} from './seedPlacement';

/** The two — and only two — placement sources. */
export const PLACEMENT_SOURCE_KINDS = ['self_hosted_seeds', 'commercial_api'] as const;
export type PlacementSourceKind = (typeof PLACEMENT_SOURCE_KINDS)[number];

/** The default and expected source. Named so callers assert against the constant. */
export const DEFAULT_PLACEMENT_SOURCE_KIND: PlacementSourceKind = 'self_hosted_seeds';

/**
 * One provider's reading from a commercial panel, for one arm.
 *
 * Deliberately COUNTS, never a percentage: D17 forbids quoting a placement
 * number, and counts are what the shared roll-up already consumes. A panel that
 * only reports percentages must convert them against its own panel size before
 * calling — the conversion is the caller's lie to own, not ours.
 */
export interface CommercialPlacementReport {
	provider: DestinationProviderKey;
	/** Absent is read as `own`; standalone every probe went through our own MTA. */
	arm?: SeedTransportArm;
	inbox: number;
	/** Gmail-style tabbed delivery. Counted as REACHED, exactly as seeds are. */
	category?: number;
	spam: number;
	/** Not found in any folder — D17's most alarming outcome. */
	missing?: number;
}

/**
 * Evidence handed to an adapter. A CLOSED union: one member per implementation.
 */
export type PlacementEvidence =
	| { kind: 'self_hosted_seeds'; observations: readonly SeedObservation[] }
	| { kind: 'commercial_api'; reports: readonly CommercialPlacementReport[] };

/**
 * The adapter interface. Both implementations satisfy it identically; the
 * caller never branches on `kind` to get a reading.
 */
export interface PlacementAdapter {
	readonly kind: PlacementSourceKind;
	/**
	 * D14/D17 — placement evidence is never high confidence, whoever gathered
	 * it. The grade has ONE home (`SEED_GATE_CONFIDENCE`, declared beside the
	 * thresholds that produce the reading) and both implementations import it:
	 * a commercial panel is a bigger sample of the SAME signal, so it reads
	 * exactly what the self-hosted path reads rather than promoting itself to a
	 * gauge. Restating the grade here would be a second opinion of one number.
	 */
	readonly confidence: SeedConfidence;
	/**
	 * Roll evidence up into the per-provider statuses gate 5 consumes.
	 *
	 * Evidence produced for the OTHER source is ignored (empty roll-up ⇒ gate 5
	 * returns `insufficient_data` ⇒ the controller HOLDS). A hold is the only
	 * safe answer to "I cannot read this"; guessing is not available.
	 */
	summarize(evidence: PlacementEvidence): SeedProviderRollup[];
}

/**
 * The panel's numbers are THIRD-PARTY INPUT and are expanded into one row per
 * mailbox, so an unclamped count is an allocation someone else controls. Both
 * caps are sized generously against the shipped self-hosted set
 * ({@link SEED_ACCOUNTS_PER_ORG_LIMIT}) — a panel reporting more mailboxes than
 * this per provider is not measuring anything gate 5 reads differently (D17:
 * status, never a percentage), so clamping costs no fidelity.
 */
export const MAX_PANEL_MAILBOXES_PER_REPORT = 200;

/** Same reasoning one level up: the report list is third-party input too. */
export const MAX_PANEL_REPORTS = 50;

/**
 * Clamp a mailbox count from an untrusted source to a non-negative integer no
 * larger than `cap`. Junk (non-number, non-finite, negative, fractional) reads
 * as the nearest sane count rather than throwing — a bad panel response may not
 * take a screen or a controller tick down (D2).
 */
function nonNegativeMailboxCount(value: number | undefined, cap: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
	return Math.min(cap, Math.floor(value));
}

/** `times` copies of one observation, as a fresh array — no caller mutation. */
function observationsOf(observation: SeedObservation, times: number): SeedObservation[] {
	const rows: SeedObservation[] = [];
	for (let index = 0; index < times; index += 1) rows.push(observation);
	return rows;
}

/**
 * Expand panel COUNTS into the same per-mailbox observations the seed poller
 * writes, so both sources go through ONE roll-up and ONE tripwire rule.
 *
 * Every count — and the report list itself — is clamped here, at the parse
 * boundary, because this is the single place a third-party number becomes an
 * allocation.
 */
export function commercialReportsToObservations(
	reports: readonly CommercialPlacementReport[]
): SeedObservation[] {
	const observations: SeedObservation[] = [];
	for (const report of reports.slice(0, MAX_PANEL_REPORTS)) {
		const arm: SeedTransportArm = report.arm ?? 'own';
		const placements: readonly [SeedPlacement, number | undefined][] = [
			['inbox', report.inbox],
			['category', report.category],
			['spam', report.spam],
			['missing', report.missing],
		];
		for (const [placement, raw] of placements) {
			const times = nonNegativeMailboxCount(raw, MAX_PANEL_MAILBOXES_PER_REPORT);
			observations.push(...observationsOf({ provider: report.provider, arm, placement }, times));
		}
	}
	return observations;
}

/** THE DEFAULT: seed mailboxes shipped in P2-6. */
export const selfHostedSeedPlacementAdapter: PlacementAdapter = {
	kind: 'self_hosted_seeds',
	confidence: SEED_GATE_CONFIDENCE,
	summarize(evidence: PlacementEvidence): SeedProviderRollup[] {
		if (evidence.kind !== 'self_hosted_seeds') return [];
		return summarizeSeedPlacement(evidence.observations);
	},
};

/** STRICTLY AN UPGRADE: a commercial placement panel. */
export const commercialPlacementApiAdapter: PlacementAdapter = {
	kind: 'commercial_api',
	confidence: SEED_GATE_CONFIDENCE,
	summarize(evidence: PlacementEvidence): SeedProviderRollup[] {
		if (evidence.kind !== 'commercial_api') return [];
		return summarizeSeedPlacement(commercialReportsToObservations(evidence.reports));
	},
};

/** What the operator has configured. Both fields may be false/zero — that is fine. */
export interface PlacementSourceConfig {
	/** Connected seed mailboxes (`externalMailAccounts` tagged `purpose: 'seed'`). */
	seedMailboxCount: number;
	/** A commercial placement API credential is present. */
	commercialApiConfigured: boolean;
}

/**
 * The one advisory this resolution may carry. It is a HINT rendered next to a
 * measurement-confidence label (D14), never an error, never a "setup
 * incomplete" nag, and never a reason to withhold a screen or a send.
 */
export type PlacementImprovementHint = 'none' | 'add_seed_mailboxes';

export interface PlacementSourceResolution {
	adapter: PlacementAdapter;
	kind: PlacementSourceKind;
	confidence: SeedConfidence;
	improvement: PlacementImprovementHint;
	/**
	 * ALWAYS `false`, as a literal type. D2 in the type system: no caller can
	 * write `if (resolution.blocking)` and have it mean anything, and no future
	 * edit can flip it without changing this type and failing its test.
	 */
	readonly blocking: false;
}

/**
 * Pick the adapter. The commercial key is an UPGRADE: when present it wins,
 * when absent NOTHING changes — the self-hosted path is the default and stays
 * fully functional.
 */
export function resolvePlacementAdapter(config: PlacementSourceConfig): PlacementSourceResolution {
	const seeds = nonNegativeMailboxCount(config.seedMailboxCount, SEED_ACCOUNTS_PER_ORG_LIMIT);
	if (config.commercialApiConfigured) {
		return {
			adapter: commercialPlacementApiAdapter,
			kind: 'commercial_api',
			confidence: commercialPlacementApiAdapter.confidence,
			improvement: 'none',
			blocking: false,
		};
	}
	return {
		adapter: selfHostedSeedPlacementAdapter,
		kind: DEFAULT_PLACEMENT_SOURCE_KIND,
		// No seed mailbox has ever been observed, so there is nothing to be
		// confident about yet. `none` is the ABSENCE of a grade — not a weaker
		// one — and is what the roll-up itself reports for an empty sample, so
		// the two agree. With seeds connected the reading carries the gate's own
		// grade, imported rather than restated.
		confidence: seeds > 0 ? SEED_GATE_CONFIDENCE : 'none',
		improvement: seeds > 0 ? 'none' : 'add_seed_mailboxes',
		blocking: false,
	};
}
