/**
 * Fixtures for the ramp gate suites.
 *
 * Arms are built from COUNTS and summarized by THE REAL SUMMARIZER — a fixture
 * assembles `transportOutcomes` bucket literals and hands them to
 * `summarizeTransportOutcomeBuckets`, so a fixture cannot pin a rate the real
 * read path would never produce, and a change to its denominators or its clamp
 * fails these suites rather than passing them. Adversarial suites override the
 * derived fields deliberately, which is the only way a poisoned value gets in.
 */

import { describe, it } from 'vitest';
import type {
	DeliverabilityCell,
	DeliverabilityStream,
	DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import type { SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';
import type { Id } from '../../../_generated/dataModel';
import {
	summarizeTransportOutcomeBuckets,
	type TransportOutcomeBucket,
	type TransportOutcomeSummary,
} from '../../../analytics/transportOutcomeSummary';
import type { EngagementGateInput } from '../engagementGate';
import { RAMP_GATE_THRESHOLDS, RAMP_STREAM_CONFIGS, type RampStreamConfig } from '../gateConfig';
import type {
	RampGateEvaluationInput,
	SeedPlacementObservation,
	SmtpBlockObservation,
} from '../gateTypes';
import { externalDataAllowed, rampGateMatrixMode, type RampGateMatrixMode } from './gateMatrixMode';

/** A fixed, arbitrary clock. Every suite injects it; nothing reads a real one. */
export const NOW = 1_760_000_000_000;

/**
 * THE HOSTILE-INPUT CATALOGUE, declared ONCE for both adversarial suites.
 *
 * `gates.adversarial.test.ts` attacks the reference-arm implementation and
 * `standaloneAdversarial.test.ts` attacks the trailing-baseline one, and the two
 * used to spell the same three poison values and the same beyond-skew timestamp
 * in two shapes. Two spellings of one catalogue is two chances for a new poison
 * shape to reach one implementation's suite and not the other's — which is
 * precisely the degraded-path rot the second suite exists to prevent (plan D3).
 * A value added here reaches both legs of the matrix at once.
 */
export const POISON_RATE_VALUES: ReadonlyArray<readonly [label: string, value: number]> = [
	['NaN', Number.NaN],
	['Infinity', Number.POSITIVE_INFINITY],
	['negative', -1],
];

/**
 * Every derived rate a hostile or buggy producer could poison, set to one value.
 *
 * ALL FOUR at once, and deliberately so: a suite that poisoned only the rate the
 * gate under test reads would still pass if a later refactor made that gate read
 * a different one.
 */
export function poisonedRates(value: number): Partial<TransportOutcomeSummary> {
	return {
		hardBounceRate: value,
		deferralRate: value,
		complaintRate: value,
		unsubscribeRate: value,
	};
}

/**
 * An observation timestamp BEYOND the skew tolerance, so it is not merely a
 * little early. Derived from the shipped tolerance rather than hand-written, so
 * widening the tolerance cannot silently turn these cases into fresh evidence.
 */
export const BEYOND_SKEW = NOW + RAMP_GATE_THRESHOLDS.maxFutureSkewMs + 60_000;

/**
 * WHICH LEG OF THE CI MATRIX THIS PROCESS IS, and — the load-bearing part —
 * whether it may use ANY external input at all.
 *
 * The matrix is plan D3's defence against the degraded path rotting, and it only
 * defends anything if the mode reaches the FIXTURES. A second leg that rebuilt the
 * same two-armed cells and merely added a handful of mode-branching assertions
 * would pass exactly when the first leg passes, so a change that quietly made a
 * reference arm load-bearing would fail both legs or neither — which is no signal
 * at all.
 *
 * So in the standalone leg the builders below REFUSE a reference arm and a
 * reference seed sweep, and every suite that genuinely needs one declares itself
 * with `describeEquipped` / `itEquipped`. What is left running in that leg is the
 * suite as a deployment with zero third-party accounts would experience it, and
 * a future fixture that reaches for an external input to make something pass
 * fails there on the PR that introduces it.
 */
export const MATRIX_MODE: RampGateMatrixMode = rampGateMatrixMode();
export const EXTERNAL_DATA_ALLOWED = externalDataAllowed(MATRIX_MODE);

/** `describe` for a group that MEASURES AGAINST A REFERENCE ARM: skipped standalone. */
export const describeEquipped = describe.skipIf(!EXTERNAL_DATA_ALLOWED);
/** `it` for a single reference-arm case inside an otherwise standalone-safe group. */
export const itEquipped = it.skipIf(!EXTERNAL_DATA_ALLOWED);

function rejectExternalInput(overrides: {
	readonly reference?: TransportOutcomeSummary | null;
	readonly referenceSeeds?: SeedPlacementObservation | null;
}): void {
	if (EXTERNAL_DATA_ALLOWED) return;
	if (overrides.reference != null) {
		throw new Error(
			`the ${MATRIX_MODE} leg was handed a reference arm: a standalone deployment has none. Wrap the case in describeEquipped/itEquipped, or build the cell with standaloneInput().`
		);
	}
	if (overrides.referenceSeeds != null) {
		throw new Error(
			`the ${MATRIX_MODE} leg was handed a reference seed sweep: a standalone deployment has none. Wrap the case in describeEquipped/itEquipped, or build the cell with standaloneInput().`
		);
	}
}

export interface ArmCounts {
	readonly sent?: number;
	readonly delivered?: number;
	readonly deferred?: number;
	readonly softBounced?: number;
	readonly hardBounced?: number;
	readonly complained?: number;
	readonly opened?: number;
	readonly clicked?: number;
	readonly unsubscribed?: number;
	readonly calibrationSent?: number;
	readonly calibrationOpened?: number;
	readonly calibrationClicked?: number;
	readonly lastRecordedAt?: number | null;
}

/**
 * One `transportOutcomes` shard document. `lastRecordedAt` is written as NaN to
 * express "counters but no usable observation timestamp" — the summarizer skips
 * a non-finite timestamp exactly as it does in production, which is how the
 * fixture reaches `lastRecordedAt: null` without hand-writing a summary.
 */
function bucket(counts: ArmCounts): TransportOutcomeBucket {
	const sent = counts.sent ?? 0;
	const recordedAt = counts.lastRecordedAt === undefined ? NOW : counts.lastRecordedAt;
	return {
		_id: 'fixture_transport_outcome' as Id<'transportOutcomes'>,
		_creationTime: NOW,
		organizationId: 'fixture_org',
		cell: 'campaign:gmail',
		arm: 'own',
		periodStart: NOW,
		shardKey: 0,
		sent,
		delivered: counts.delivered ?? sent,
		deferred: counts.deferred ?? 0,
		softBounced: counts.softBounced ?? 0,
		hardBounced: counts.hardBounced ?? 0,
		complained: counts.complained ?? 0,
		opened: counts.opened ?? 0,
		clicked: counts.clicked ?? 0,
		unsubscribed: counts.unsubscribed ?? 0,
		calibrationSent: counts.calibrationSent ?? 0,
		calibrationOpened: counts.calibrationOpened ?? 0,
		calibrationClicked: counts.calibrationClicked ?? 0,
		lastRecordedAt: recordedAt === null ? Number.NaN : recordedAt,
	};
}

/**
 * Build an arm summary from counts through the REAL summarizer (ADR-0042).
 *
 * ONE builder for every suite, including the gate-4 ones: an arm can carry BOTH
 * a stratified (general) engagement story and a calibration-slice one, so a
 * suite can make the two disagree on purpose. That disagreement is the whole
 * point of `engagementRatioCalibration.test.ts` — gate 4 must read the
 * calibration numbers and ignore the general ones — and it needs no second,
 * narrower count type to express it.
 */
export function arm(
	counts: ArmCounts,
	overrides: Partial<TransportOutcomeSummary> = {}
): TransportOutcomeSummary {
	return { ...summarizeTransportOutcomeBuckets([bucket(counts)]), ...overrides };
}

/**
 * An arm with `sent` sends and exactly `rateFractionValue` of them counted into
 * one column. Counts are integers, so the fixture rounds — the suites use
 * denominators that divide the thresholds exactly.
 */
export function armWith(
	column: 'hardBounced' | 'complained' | 'deferred',
	sent: number,
	rateFractionValue: number,
	overrides: Partial<TransportOutcomeSummary> = {}
): TransportOutcomeSummary {
	const count = Math.round(sent * rateFractionValue);
	const counts: ArmCounts =
		column === 'hardBounced'
			? { sent, hardBounced: count }
			: column === 'complained'
				? { sent, complained: count }
				: { sent, deferred: count };
	return arm(counts, overrides);
}

/**
 * The tail of a seed sweep: the two placements the gate does not branch on by
 * name, plus the clock.
 *
 * NAMED RATHER THAN POSITIONAL because they are rare and `seeds(20, 0, 0, 0, 2)`
 * says nothing. The three common placements stay positional so the suites keep
 * reading as inbox/spam/missing.
 */
export interface SeedSweepTail {
	readonly category?: number;
	readonly deleted?: number;
	readonly observedAt?: number;
}

/**
 * One arm's counted sweep, in the shape `analytics/seedPlacementSweeps.ts`
 * builds: ALL FIVE placements, zero where nothing landed.
 *
 * `category` is REACHED and `deleted` is not, so a fixture that could only spell
 * inbox/spam/missing left the gate's two hardest placements to the e2e suite
 * alone — and a gate that folded the sweep back down to three would still pass
 * every suite built on it.
 */
export function seeds(
	inbox: number,
	spam: number,
	missing = 0,
	tail: SeedSweepTail = {}
): SeedPlacementObservation {
	const { category = 0, deleted = 0, observedAt = NOW } = tail;
	return { inbox, category, spam, deleted, missing, observedAt };
}

/**
 * A window of classified SMTP responses, `count` of them in `category`.
 *
 * The category defaults to a real BLOCK category so that a fixture asking for
 * blocks gets blocks; a suite that wants counted-but-NOT-blocking responses names
 * a rate-pressure category instead, and the gate's numerator then sums to zero
 * rather than being asserted away by a second field.
 */
/**
 * `count` and `category` BUILD the map, so a caller may not also supply one:
 * `...rest` would overwrite the map this fixture just built and the numerator
 * would stop describing the category names beside it — which is the exact
 * disagreement `SmtpBlockObservation`'s docblock says must not be expressible.
 * The union makes the two spellings mutually exclusive at the type level.
 */
export type BlockOverrides =
	| (Omit<Partial<SmtpBlockObservation>, 'blockedByCategory'> & {
			readonly category?: SmtpFailureCategory;
			readonly blockedByCategory?: never;
	  })
	| (Partial<SmtpBlockObservation> & { readonly category?: never });

export function blocks(
	count: number,
	observed: number,
	overrides: BlockOverrides = {}
): SmtpBlockObservation {
	const { category = 'content_rejected', ...rest } = overrides;
	const blockedByCategory: Partial<Record<SmtpFailureCategory, number>> = {};
	blockedByCategory[category] = count;
	// `...rest` last is safe now that the type forbids `category` and
	// `blockedByCategory` together: it either carries the caller's WHOLE map (the
	// map-only spelling, in which `count` is unused by construction) or it carries
	// no map at all and leaves the one built above intact.
	return { observed, blockedByCategory, observedAt: NOW, ...rest };
}

export const CAMPAIGN_CONFIG: RampStreamConfig = RAMP_STREAM_CONFIGS.campaign;

export function input(
	overrides: Partial<RampGateEvaluationInput> & { readonly own: TransportOutcomeSummary }
): RampGateEvaluationInput {
	rejectExternalInput(overrides);
	return {
		config: CAMPAIGN_CONFIG,
		reference: null,
		previousCleanStreak: 0,
		now: NOW,
		...overrides,
	};
}

/** A ramp cell, campaign-stream unless a suite says otherwise. */
export function engagementCell(
	destinationProvider: DestinationProviderKey,
	stream: DeliverabilityStream = 'campaign'
): DeliverabilityCell {
	return { stream, destinationProvider };
}

/**
 * Gate 4's input. Gmail (an opens-gated cell) and no reference arm by default.
 *
 * `ownRecent` defaults to `own` because most suites evaluate a single window and
 * say so; the field is required on the real input precisely so a production
 * caller cannot leave the window unstated.
 */
export function engagementInput(
	overrides: Partial<EngagementGateInput> & { readonly own: TransportOutcomeSummary }
): EngagementGateInput {
	rejectExternalInput(overrides);
	return {
		cell: engagementCell('gmail'),
		reference: null,
		ownRecent: overrides.own,
		now: NOW,
		...overrides,
	};
}

/**
 * A healthy STANDALONE cell: no reference arm anywhere, a clean 30-day trailing
 * baseline for the substitutions to compare against, and self-hosted seeds.
 *
 * Deliberately built WITHOUT a `reference` field rather than with an explicitly
 * null one, so a suite that adds a reference arm to a standalone fixture has to
 * say so out loud.
 */
export function standaloneInput(
	overrides: Partial<RampGateEvaluationInput> = {}
): RampGateEvaluationInput {
	rejectExternalInput(overrides);
	const base = input({
		own: arm({ sent: 10_000, deferred: 100, hardBounced: 100, complained: 5, unsubscribed: 30 }),
		ownTrailingBaseline: arm({
			sent: 40_000,
			deferred: 400,
			hardBounced: 400,
			complained: 20,
			unsubscribed: 120,
		}),
		ownSeeds: seeds(19, 1),
	});
	return { ...base, ...overrides };
}

/**
 * A both-arms-healthy baseline: every gate passes, nothing is thin or stale.
 *
 * THROWS IN THE STANDALONE LEG, by construction rather than by assertion: this
 * fixture IS a reference-arm cell, so a suite that reaches for it in the leg that
 * has no reference transport is a suite whose subject that leg cannot have. Wrap
 * it in `describeEquipped`.
 */
export function healthyInput(
	overrides: Partial<RampGateEvaluationInput> = {}
): RampGateEvaluationInput {
	if (!EXTERNAL_DATA_ALLOWED) {
		throw new Error(
			`healthyInput() builds a REFERENCE-ARM cell and the ${MATRIX_MODE} leg has no reference transport. Use standaloneInput(), or declare the suite with describeEquipped/itEquipped.`
		);
	}
	const base = input({
		own: arm({ sent: 10_000, deferred: 100, hardBounced: 10, complained: 5 }),
		reference: arm({ sent: 10_000, deferred: 100, hardBounced: 10, complained: 5 }),
		ownSeeds: seeds(19, 1),
		referenceSeeds: seeds(19, 1),
	});
	return { ...base, ...overrides };
}

/**
 * A healthy input FOR THE CURRENT LEG — and, standalone, one that is SCRUBBED of
 * every external input rather than merely built without one.
 *
 * The scrub is what the matrix proof asserts on: hand this builder a reference
 * arm on purpose and the standalone leg strips it, so a leg that reported green
 * while quietly measuring against a relay is a state the suite can detect.
 */
export function matrixInput(
	mode: RampGateMatrixMode,
	overrides: Partial<RampGateEvaluationInput> = {}
): RampGateEvaluationInput {
	if (mode === 'reference_arm') return healthyInput(overrides);
	// Strip BEFORE building, because `standaloneInput` refuses what this function
	// promises to remove: the scrub is this builder's contract, not a hole in the
	// leg's guard.
	const { reference, referenceSeeds, ...scrubbed } = overrides;
	return { ...standaloneInput(scrubbed), reference: null, referenceSeeds: null };
}
