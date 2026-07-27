/**
 * Transport outcomes — the PURE core (plan D5, D15).
 *
 * Everything in this file is a total function of its arguments: no clock, no
 * database, no environment. Two decisions live here and nowhere else:
 *
 *   1. WHICH COUNTER an event bumps (including the calibration twin, plan D8),
 *      and which Send lifecycle transition is a transport outcome at all;
 *   2. HOW A WINDOW OF BUCKETS BECOMES A SUMMARY — the ONE place a rate is
 *      computed. Rates are DERIVED ON READ and never stored (ADR-0042), so the
 *      ramp controller and the delivery dashboard cannot disagree about a
 *      number; they both end up here.
 *
 * Split out of `transportOutcomes.ts` because that module reached the
 * CONVENTIONS.md file-size cap, and because the arithmetic the controller's
 * correctness rests on should be testable without a database at all.
 */

import type { Doc } from '../_generated/dataModel';
import { startOfDayUtc } from '../lib/clock';

export type TransportOutcomeBucket = Doc<'transportOutcomes'>;
export type TransportOutcomeArm = TransportOutcomeBucket['arm'];

/** The outcome vocabulary. One event bumps one general counter. */
export type TransportOutcomeEvent =
	| 'sent'
	| 'delivered'
	| 'deferred'
	| 'soft_bounced'
	| 'hard_bounced'
	| 'complained'
	| 'opened'
	| 'clicked'
	| 'unsubscribed';

/** Counter columns on the bucket — every one an integer, never a rate. */
export type TransportOutcomeCounter =
	| 'sent'
	| 'delivered'
	| 'deferred'
	| 'softBounced'
	| 'hardBounced'
	| 'complained'
	| 'opened'
	| 'clicked'
	| 'unsubscribed'
	| 'calibrationSent'
	| 'calibrationOpened'
	| 'calibrationClicked';

const GENERAL_COUNTER_FOR_EVENT: Readonly<Record<TransportOutcomeEvent, TransportOutcomeCounter>> =
	{
		sent: 'sent',
		delivered: 'delivered',
		deferred: 'deferred',
		soft_bounced: 'softBounced',
		hard_bounced: 'hardBounced',
		complained: 'complained',
		opened: 'opened',
		clicked: 'clicked',
		unsubscribed: 'unsubscribed',
	};

/**
 * The calibration slice (plan D8) is counted SEPARATELY — it is the ONLY input
 * to the engagement-ratio gate, because stratified assignment biases every other
 * comparison. Only the three counters the gate reads have a calibration twin;
 * a calibration bounce is still a bounce and belongs in the general counter.
 */
const CALIBRATION_COUNTER_FOR_EVENT: Readonly<
	Partial<Record<TransportOutcomeEvent, TransportOutcomeCounter>>
> = {
	sent: 'calibrationSent',
	opened: 'calibrationOpened',
	clicked: 'calibrationClicked',
};

/**
 * Which counters one event bumps.
 *
 * A calibration event bumps BOTH its general counter and its calibration twin:
 * the calibration slice is part of the send, so removing it from the general
 * denominator would make the cell's bounce rate disagree with reality. The twin
 * is an ADDITIONAL, narrower counter, not a partition.
 */
export function transportOutcomeCounters(
	event: TransportOutcomeEvent,
	isCalibration: boolean
): readonly TransportOutcomeCounter[] {
	const general = GENERAL_COUNTER_FOR_EVENT[event];
	if (!isCalibration) return [general];
	const calibration = CALIBRATION_COUNTER_FOR_EVENT[event];
	return calibration === undefined ? [general] : [general, calibration];
}

/**
 * Map a Send lifecycle transition onto an outcome event.
 *
 * `failed` is deliberately unmapped: it is a LOCAL non-delivery (screening,
 * suppression, routing exhaustion, intake uncertainty) and counting it as a
 * transport outcome would put our own refusals into the arm comparison. The
 * lifecycle's queued→terminal MTA path already re-supplies the `sent`
 * denominator where an envelope provably reached the wire.
 *
 * `opened` and `clicked` are unmapped HERE ON PURPOSE, and this is the one
 * subtlety in the module. Every shipped engagement counter in the product
 * (`daily_stats_bump`, `campaign_stats_opened`/`_clicked`) counts UNIQUES — it
 * is gated on `isFirstOpen` / `isFirstClick` inside the reducer — while a
 * transition is emitted for every re-fire (image prefetch reopens a message 3-5
 * times). Mapping the transition would make `openRate` an opens-per-delivered
 * number that routinely exceeds 1.0 and disagrees with the campaign dashboard
 * over the same traffic, which is precisely what plan D5 exists to prevent.
 * So the engagement outcome effects are pushed by `reduceOpened`/`reduceClicked`
 * from inside their existing uniqueness gate, next to the shipped counter they
 * must agree with. Do not re-add them here.
 */
export function transportOutcomeEventForTransition(
	to: 'sent' | 'failed' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained',
	bounceType?: 'hard' | 'soft'
): TransportOutcomeEvent | null {
	switch (to) {
		case 'sent':
			return 'sent';
		case 'delivered':
			return 'delivered';
		case 'complained':
			return 'complained';
		case 'bounced':
			return bounceType === 'hard' ? 'hard_bounced' : 'soft_bounced';
		case 'opened':
		case 'clicked':
		case 'failed':
			return null;
	}
}

// ============ SUMMARY (derive-on-read; the ONLY place rates exist) ============

export interface TransportOutcomeTotals {
	readonly sent: number;
	readonly delivered: number;
	readonly deferred: number;
	readonly softBounced: number;
	readonly hardBounced: number;
	readonly complained: number;
	readonly opened: number;
	readonly clicked: number;
	readonly unsubscribed: number;
	readonly calibrationSent: number;
	readonly calibrationOpened: number;
	readonly calibrationClicked: number;
}

/**
 * A window's summed counters plus every rate derived from them.
 *
 * DENOMINATORS ARE NOT ALL THE SAME, and a gate that compares two of these
 * numbers must know which it is holding:
 *
 *   - `deliveryRate`, `deferralRate`, `bounceRate`, `hardBounceRate` and
 *     `complaintRate` are denominated on `sent`;
 *   - `openRate`, `clickRate` and `unsubscribeRate` are denominated on
 *     `delivered`. The plan makes unsubscribe the complaint-equivalent for the
 *     standalone arm (no feedback loop to report complaints), so a standalone
 *     gate comparing `unsubscribeRate` against `complaintRate` is comparing two
 *     differently-denominated numbers — convert, or compare like for like.
 *
 * Every rate here is bounded to [0, 1]: the open/click numerators count UNIQUE
 * opens and clicks, because the effects that feed them are emitted from inside
 * the lifecycle reducers' `isFirstOpen` / `isFirstClick` gate, exactly like the
 * shipped dashboard counters. See `transportOutcomeEventForTransition`.
 */
export interface TransportOutcomeSummary extends TransportOutcomeTotals {
	/** softBounced + hardBounced — summed, never stored. */
	readonly bounced: number;
	/** Every rate below is DERIVED ON READ and is 0 when its denominator is 0. */
	readonly deliveryRate: number;
	readonly deferralRate: number;
	readonly bounceRate: number;
	readonly hardBounceRate: number;
	readonly complaintRate: number;
	readonly openRate: number;
	readonly clickRate: number;
	readonly unsubscribeRate: number;
	/** The calibration slice's own rates — the engagement-ratio gate's input. */
	readonly calibrationOpenRate: number;
	readonly calibrationClickRate: number;
	/**
	 * Freshness: the newest `lastRecordedAt` across the summed buckets, or
	 * `null` when the window is empty. The controller may only INCREASE on fresh
	 * evidence (plan D9/D10), and it learns how fresh the evidence is through
	 * this one read seam rather than by re-reading the raw rows.
	 */
	readonly lastRecordedAt: number | null;
}

/** A zeroed counter set — the insert shape and the summation identity. */
export const ZERO_TRANSPORT_OUTCOME_TOTALS: TransportOutcomeTotals = {
	sent: 0,
	delivered: 0,
	deferred: 0,
	softBounced: 0,
	hardBounced: 0,
	complained: 0,
	opened: 0,
	clicked: 0,
	unsubscribed: 0,
	calibrationSent: 0,
	calibrationOpened: 0,
	calibrationClicked: 0,
};

/**
 * A counter that is missing, negative, NaN or infinite contributes 0. Convex
 * numbers are float64 and this table is written by a hot path: a single poisoned
 * document must not turn an entire cell's rate into NaN and make every gate
 * "insufficient data" forever.
 */
export function safeOutcomeCount(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Zero-denominator guard — the one place a division happens. */
function rate(numerator: number, denominator: number): number {
	return denominator > 0 ? numerator / denominator : 0;
}

export interface TransportOutcomeWindow {
	/** Inclusive lower bound; floored to its UTC day, since buckets are daily. */
	readonly since?: number;
	/** Exclusive upper bound. */
	readonly until?: number;
}

/**
 * Normalize a window to bucket-day granularity. A non-finite bound is treated
 * as absent rather than as an empty window: `v.number()` is a float64, so `NaN`
 * is a valid argument and must not silently blank out a cell's history.
 */
export function transportOutcomeWindowBounds(window: TransportOutcomeWindow | undefined): {
	sinceDay: number;
	until: number;
} {
	const since = window?.since;
	const until = window?.until;
	return {
		sinceDay: since !== undefined && Number.isFinite(since) ? startOfDayUtc(since) : -Infinity,
		until: until !== undefined && Number.isFinite(until) ? until : Infinity,
	};
}

/**
 * Sum buckets (across ALL shards and days in the window) and derive every rate.
 * PURE — no clock, no database — so the arithmetic that the controller and the
 * dashboard both depend on is exhaustively unit-testable.
 */
export function summarizeTransportOutcomeBuckets(
	buckets: readonly TransportOutcomeBucket[],
	window?: TransportOutcomeWindow
): TransportOutcomeSummary {
	const { sinceDay, until } = transportOutcomeWindowBounds(window);
	const totals: { -readonly [K in keyof TransportOutcomeTotals]: number } = {
		...ZERO_TRANSPORT_OUTCOME_TOTALS,
	};

	let lastRecordedAt: number | null = null;

	for (const bucket of buckets) {
		if (!Number.isFinite(bucket.periodStart)) continue;
		if (bucket.periodStart < sinceDay || bucket.periodStart >= until) continue;
		const recordedAt = bucket.lastRecordedAt;
		if (
			recordedAt !== undefined &&
			Number.isFinite(recordedAt) &&
			(lastRecordedAt === null || recordedAt > lastRecordedAt)
		) {
			lastRecordedAt = recordedAt;
		}
		totals.sent += safeOutcomeCount(bucket.sent);
		totals.delivered += safeOutcomeCount(bucket.delivered);
		totals.deferred += safeOutcomeCount(bucket.deferred);
		totals.softBounced += safeOutcomeCount(bucket.softBounced);
		totals.hardBounced += safeOutcomeCount(bucket.hardBounced);
		totals.complained += safeOutcomeCount(bucket.complained);
		totals.opened += safeOutcomeCount(bucket.opened);
		totals.clicked += safeOutcomeCount(bucket.clicked);
		totals.unsubscribed += safeOutcomeCount(bucket.unsubscribed);
		totals.calibrationSent += safeOutcomeCount(bucket.calibrationSent);
		totals.calibrationOpened += safeOutcomeCount(bucket.calibrationOpened);
		totals.calibrationClicked += safeOutcomeCount(bucket.calibrationClicked);
	}

	const bounced = totals.softBounced + totals.hardBounced;
	return {
		...totals,
		bounced,
		deliveryRate: rate(totals.delivered, totals.sent),
		deferralRate: rate(totals.deferred, totals.sent),
		bounceRate: rate(bounced, totals.sent),
		hardBounceRate: rate(totals.hardBounced, totals.sent),
		complaintRate: rate(totals.complained, totals.sent),
		openRate: rate(totals.opened, totals.delivered),
		clickRate: rate(totals.clicked, totals.delivered),
		unsubscribeRate: rate(totals.unsubscribed, totals.delivered),
		calibrationOpenRate: rate(totals.calibrationOpened, totals.calibrationSent),
		calibrationClickRate: rate(totals.calibrationClicked, totals.calibrationSent),
		lastRecordedAt,
	};
}
