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

import type {
	DeliverabilityCell,
	DeliverabilityStream,
	DestinationProviderKey,
} from '@owlat/shared/deliverabilityRouting';
import type { Id } from '../../../_generated/dataModel';
import {
	summarizeTransportOutcomeBuckets,
	type TransportOutcomeBucket,
	type TransportOutcomeSummary,
} from '../../../analytics/transportOutcomeSummary';
import type { EngagementGateInput } from '../engagementGate';
import { RAMP_STREAM_CONFIGS, type RampStreamConfig } from '../gateConfig';
import type {
	RampGateEvaluationInput,
	SeedPlacementObservation,
	SmtpBlockObservation,
} from '../gateTypes';

/** A fixed, arbitrary clock. Every suite injects it; nothing reads a real one. */
export const NOW = 1_760_000_000_000;

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

export function seeds(
	inbox: number,
	spam: number,
	missing = 0,
	observedAt = NOW
): SeedPlacementObservation {
	return { inbox, spam, missing, observedAt };
}

/**
 * A window of classified SMTP responses. `categories` defaults to a real BLOCK
 * category so that a fixture asking for blocks gets blocks; a suite that wants
 * counted-but-not-blocking responses states its own categories.
 */
export function blocks(
	blocked: number,
	observed: number,
	overrides: Partial<SmtpBlockObservation> = {}
): SmtpBlockObservation {
	return {
		blocked,
		observed,
		categories: ['content_rejected'],
		observedAt: NOW,
		...overrides,
	};
}

export const CAMPAIGN_CONFIG: RampStreamConfig = RAMP_STREAM_CONFIGS.campaign;

export function input(
	overrides: Partial<RampGateEvaluationInput> & { readonly own: TransportOutcomeSummary }
): RampGateEvaluationInput {
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

/** A both-arms-healthy baseline: every gate passes, nothing is thin or stale. */
export function healthyInput(
	overrides: Partial<RampGateEvaluationInput> = {}
): RampGateEvaluationInput {
	const base = input({
		own: arm({ sent: 10_000, deferred: 100, hardBounced: 10, complained: 5 }),
		reference: arm({ sent: 10_000, deferred: 100, hardBounced: 10, complained: 5 }),
		ownSeeds: seeds(19, 1),
		referenceSeeds: seeds(19, 1),
	});
	return { ...base, ...overrides };
}
