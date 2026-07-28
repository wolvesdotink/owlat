/**
 * Deliverability dashboard — the PURE view assembly (plan D5, D14, D15).
 *
 * SHIP THE MEASUREMENT BEFORE THE CONTROL. Everything here is a total function
 * of its arguments: no clock, no database, no environment. The query shell in
 * `deliverabilityDashboard.ts` loads, calls, returns.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: a rate is never computed here.
 * Every rate on the wire comes out of `summarizeTransportOutcomeBuckets` — the
 * ONE derivation seam (ADR-0042 / plan D5) — so the controller's gates and this
 * screen cannot disagree about a number. This module groups buckets into days,
 * hands each day's rows to that summarizer, and labels the result. If you find
 * yourself typing `/` next to a counter in this file, you are writing the bug
 * D5 exists to prevent.
 *
 * CONFIDENCE (plan D14). P1-7 owns the standalone (trailing-baseline) evaluator
 * and will own the confidence model with it. Until it lands, confidence is
 * derived HERE from the two facts the dashboard already holds — is there a
 * second arm, and is the sample above the gates' own floors — and is expressed
 * as a level plus machine-readable improvement codes. It is deliberately a
 * small, replaceable function: when P1-7 lands its model, this one is deleted,
 * not extended.
 *
 * D2 IS THE FRAME. A missing reference transport, a missing seed set and a
 * missing external account are all SUPPORTED CONFIGURATIONS. They lower
 * confidence and they say so plainly. Nothing here produces an error, a warning
 * or a "setup incomplete" state, and no field on the wire is named as one.
 */

import type { DeliverabilityCell } from '@owlat/shared/deliverabilityRouting';
import { startOfDayUtc } from '../lib/clock';
import {
	summarizeTransportOutcomeBuckets,
	type TransportOutcomeBucketCounts,
	type TransportOutcomeSummary,
} from '../analytics/transportOutcomeSummary';
import type { RampGateEvaluation, RampGateResult } from './ramp/gateTypes';
import { RAMP_GATE_SAMPLE_FLOORS } from './ramp/gateConfig';

/** Declared ONCE for the whole feature; the query shell imports it from here. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days of trend the screen renders at most — one bounded series. */
export const DASHBOARD_MAX_TREND_DAYS = 30;

// ============ WINDOW ============

/** The evaluation window — the ramp's own weekly cadence, and NOT negotiable. */
export const DASHBOARD_WINDOW_DAYS = 7;

/**
 * The trailing baseline gate 4b compares against. Its width is
 * `BASELINE_DAYS - BASELINE_GAP_DAYS`, and the gap is exactly the evaluation
 * window — so the baseline ends where the window begins.
 */
const BASELINE_DAYS = 30;
const BASELINE_GAP_DAYS = DASHBOARD_WINDOW_DAYS;
const BASELINE_WIDTH_DAYS = BASELINE_DAYS - BASELINE_GAP_DAYS;

export interface DashboardWindow {
	/** Inclusive start of the evaluation window, at UTC-day granularity. */
	readonly sinceDay: number;
	/** Exclusive end of the evaluation window. */
	readonly untilDay: number;
	/** Inclusive start of the slow-poison floor's trailing baseline. */
	readonly baselineSinceDay: number;
	/** Exclusive end of that baseline — equal to `sinceDay`, by construction. */
	readonly baselineUntilDay: number;
	/** The widest bound any sub-view derives: one index read has to cover it. */
	readonly readSinceDay: number;
}

/**
 * The one window every sub-view of the screen is derived from.
 *
 * THE EVALUATION WINDOW IS PINNED AT 7 DAYS and there is deliberately no way to
 * ask for another one. The screen's whole premise is that it runs the code the
 * ramp controller will run, and gate 4b's trailing baseline is contracted to be
 * DISJOINT from the recent window it is compared against — a baseline that
 * CONTAINS the recent window measures a decay against a baseline the decay has
 * already dragged down, so the tripwire fires late. Deriving both from one
 * function makes `baselineUntilDay === sinceDay` true by construction rather
 * than true at the default and false everywhere else.
 */
export function dashboardWindow(now: number): DashboardWindow {
	const untilDay = startOfDayUtc(now) + DAY_MS;
	const sinceDay = untilDay - DASHBOARD_WINDOW_DAYS * DAY_MS;
	const baselineSinceDay = sinceDay - BASELINE_WIDTH_DAYS * DAY_MS;
	return {
		sinceDay,
		untilDay,
		baselineSinceDay,
		// Disjoint by construction: the baseline ends where the window begins.
		baselineUntilDay: sinceDay,
		readSinceDay: baselineSinceDay,
	};
}

// ============ TREND ============

export interface DashboardTrendPoint {
	/** UTC day start this point summarizes. */
	readonly day: number;
	readonly own: TransportOutcomeSummary;
	/** `null` when no reference transport is configured (D2), not "no data". */
	readonly reference: TransportOutcomeSummary | null;
}

/**
 * Index rows by the UTC day they belong to, ONCE. The shell reads 30 days of
 * shards per arm; summarizing each day by re-scanning the whole array would
 * make one dashboard load quadratic in the read span for no reason.
 */
function bucketsByDay(
	buckets: readonly TransportOutcomeBucketCounts[]
): Map<number, TransportOutcomeBucketCounts[]> {
	const byDay = new Map<number, TransportOutcomeBucketCounts[]>();
	for (const bucket of buckets) {
		if (!Number.isFinite(bucket.periodStart)) continue;
		const existing = byDay.get(bucket.periodStart);
		if (existing === undefined) byDay.set(bucket.periodStart, [bucket]);
		else existing.push(bucket);
	}
	return byDay;
}

/**
 * One point per UTC day in `[sinceDay, untilDay)`, derived by re-running THE
 * summarizer over each day's slice. Days with no rows are still emitted — a
 * quiet day is a fact about the cell, and a trend with holes silently punched
 * out of it reads as continuous traffic.
 */
export function buildDashboardTrend(input: {
	readonly ownBuckets: readonly TransportOutcomeBucketCounts[];
	readonly referenceBuckets: readonly TransportOutcomeBucketCounts[] | null;
	readonly sinceDay: number;
	readonly untilDay: number;
}): DashboardTrendPoint[] {
	const { ownBuckets, referenceBuckets, sinceDay, untilDay } = input;
	if (!Number.isFinite(sinceDay) || !Number.isFinite(untilDay) || untilDay <= sinceDay) return [];
	const ownByDay = bucketsByDay(ownBuckets);
	const referenceByDay = referenceBuckets === null ? null : bucketsByDay(referenceBuckets);
	const points: DashboardTrendPoint[] = [];
	const days = Math.min(Math.ceil((untilDay - sinceDay) / DAY_MS), DASHBOARD_MAX_TREND_DAYS);
	for (let index = 0; index < days; index += 1) {
		const day = sinceDay + index * DAY_MS;
		const window = { since: day, until: day + DAY_MS };
		points.push({
			day,
			// The empty slice still goes through the summarizer: a zero-volume day
			// must carry the same zeroed shape every other day carries.
			own: summarizeTransportOutcomeBuckets(ownByDay.get(day) ?? [], window),
			reference:
				referenceByDay === null
					? null
					: summarizeTransportOutcomeBuckets(referenceByDay.get(day) ?? [], window),
		});
	}
	return points;
}

// ============ CONFIDENCE (D14) ============

/**
 * How much this cell's measurement is worth.
 *
 *  - `none`   — nothing was sent in the window. Not a problem, not a warning.
 *  - `low`    — one arm only, or a sample below the gates' floors. The ramp
 *               still moves; it just moves on thinner evidence.
 *  - `medium` — two arms, BOTH above the bounce/deferral floors, but the
 *               engagement comparison's calibration slice is still too thin.
 *  - `high`   — two arms, every floor met on both of them.
 */
export type DashboardConfidenceLevel = 'none' | 'low' | 'medium' | 'high';

/**
 * What would raise it. Machine-readable so the UI owns the sentence and the
 * server owns the judgement — and so a code can never render as an error.
 */
export type DashboardConfidenceImprovement =
	| 'connect_reference_transport'
	| 'add_seed_mailboxes'
	| 'send_more_volume';

export interface DashboardConfidence {
	readonly level: DashboardConfidenceLevel;
	readonly improvements: readonly DashboardConfidenceImprovement[];
}

export function dashboardConfidence(input: {
	readonly own: TransportOutcomeSummary;
	readonly reference: TransportOutcomeSummary | null;
	readonly hasSeedCoverage: boolean;
}): DashboardConfidence {
	const { own, reference, hasSeedCoverage } = input;
	// The floor the two-armed gates actually apply to a raw send count. The
	// calibration slice has its own, larger floor below.
	const armFloor = RAMP_GATE_SAMPLE_FLOORS.hardBounce;
	const calibrationFloor = RAMP_GATE_SAMPLE_FLOORS.engagement;
	const improvements: DashboardConfidenceImprovement[] = [];
	if (reference === null) improvements.push('connect_reference_transport');
	if (!hasSeedCoverage) improvements.push('add_seed_mailboxes');

	if (own.sent <= 0) {
		return { level: 'none', improvements };
	}
	// BOTH arms are measured against the floor, not just the own one: a cell
	// whose reference arm has a handful of sends has every two-armed gate
	// holding on `reference_sample_below_floor`, so calling that `medium`
	// would put a confident number beside a column of "not enough data yet".
	const thin = own.sent < armFloor || (reference !== null && reference.sent < armFloor);
	if (thin) improvements.push('send_more_volume');

	if (reference === null || thin) {
		return { level: 'low', improvements };
	}
	const calibrated =
		own.calibrationSent >= calibrationFloor && reference.calibrationSent >= calibrationFloor;
	if (!calibrated) improvements.push('send_more_volume');
	return { level: calibrated ? 'high' : 'medium', improvements };
}

// ============ CELL VIEW ============

/**
 * A gate's verdict as it goes on the wire — the gate result itself.
 *
 * DELIBERATELY AN ALIAS, NOT A COPY. `RampGateResult` is already exactly
 * `{ gate, status, reason, measurement }` and is DISCRIMINATED on `status`;
 * re-declaring it field by field flattens the discriminant, so the screen loses
 * the guarantee that a hold reason belongs to a hold and a decided reason to a
 * decision — and its explanation switch can no longer be checked for
 * exhaustiveness. The numbers behind the verdict travel with it and are rendered
 * beside it, never re-derived.
 */
export type DashboardGateView = RampGateResult;

export interface DashboardCellView {
	readonly cell: DeliverabilityCell;
	readonly cellKey: string;
	/** Fraction of the cell the own MTA carries, resolved through D1's helper. */
	readonly ownShare: number;
	readonly phaseCeiling: number | null;
	/**
	 * Consecutive clean windows INCLUDING the one on screen — the evaluator's
	 * number, not the STORED `deliverabilityRouteStates.cleanStreak`, which is the
	 * PRIOR streak and is one lower whenever this window is clean. Two different
	 * numbers under one name on one screen is how a reader learns to distrust it.
	 */
	readonly cleanStreakIncludingThisWindow: number;
	readonly own: TransportOutcomeSummary;
	/** `null` = standalone cell (D2), rendered with its confidence caveat. */
	readonly reference: TransportOutcomeSummary | null;
	readonly verdict: RampGateEvaluation['verdict'];
	readonly failedGate: RampGateResult['gate'] | null;
	readonly requiresCorroboration: boolean;
	readonly gates: readonly DashboardGateView[];
	readonly confidence: DashboardConfidence;
	readonly trend: readonly DashboardTrendPoint[];
}

/**
 * Assemble one cell's view. Every number in the result is either a counter or a
 * rate the summarizer already derived; this function copies, it does not
 * compute.
 */
export function buildDashboardCellView(input: {
	readonly cell: DeliverabilityCell;
	readonly cellKey: string;
	readonly ownShare: number;
	readonly phaseCeiling: number | null;
	readonly own: TransportOutcomeSummary;
	readonly reference: TransportOutcomeSummary | null;
	readonly evaluation: RampGateEvaluation;
	readonly hasSeedCoverage: boolean;
	readonly trend: readonly DashboardTrendPoint[];
}): DashboardCellView {
	const { evaluation } = input;
	return {
		cell: input.cell,
		cellKey: input.cellKey,
		ownShare: input.ownShare,
		phaseCeiling: input.phaseCeiling,
		cleanStreakIncludingThisWindow: evaluation.cleanStreak,
		own: input.own,
		reference: input.reference,
		verdict: evaluation.verdict,
		failedGate: evaluation.failedGate ?? null,
		requiresCorroboration: evaluation.requiresCorroboration,
		gates: evaluation.perGate,
		confidence: dashboardConfidence({
			own: input.own,
			reference: input.reference,
			hasSeedCoverage: input.hasSeedCoverage,
		}),
		trend: input.trend,
	};
}
