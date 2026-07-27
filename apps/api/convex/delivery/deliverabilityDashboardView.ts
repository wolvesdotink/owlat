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
import {
	summarizeTransportOutcomeBuckets,
	type TransportOutcomeBucket,
	type TransportOutcomeSummary,
} from '../analytics/transportOutcomeSummary';
import type { RampGateEvaluation, RampGateResult } from './ramp/gateTypes';
import { RAMP_GATE_SAMPLE_FLOORS } from './ramp/gateConfig';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days of trend the screen renders at most — one bounded series. */
export const DASHBOARD_MAX_TREND_DAYS = 30;

// ============ TREND ============

export interface DashboardTrendPoint {
	/** UTC day start this point summarizes. */
	readonly day: number;
	readonly own: TransportOutcomeSummary;
	/** `null` when no reference transport is configured (D2), not "no data". */
	readonly reference: TransportOutcomeSummary | null;
}

/**
 * One point per UTC day in `[sinceDay, untilDay)`, derived by re-running THE
 * summarizer over each day's slice. Days with no rows are still emitted — a
 * quiet day is a fact about the cell, and a trend with holes silently punched
 * out of it reads as continuous traffic.
 */
export function buildDashboardTrend(input: {
	readonly ownBuckets: readonly TransportOutcomeBucket[];
	readonly referenceBuckets: readonly TransportOutcomeBucket[] | null;
	readonly sinceDay: number;
	readonly untilDay: number;
}): DashboardTrendPoint[] {
	const { ownBuckets, referenceBuckets, sinceDay, untilDay } = input;
	if (!Number.isFinite(sinceDay) || !Number.isFinite(untilDay) || untilDay <= sinceDay) return [];
	const points: DashboardTrendPoint[] = [];
	const days = Math.min(Math.ceil((untilDay - sinceDay) / DAY_MS), DASHBOARD_MAX_TREND_DAYS);
	for (let index = 0; index < days; index += 1) {
		const day = sinceDay + index * DAY_MS;
		const window = { since: day, until: day + DAY_MS };
		points.push({
			day,
			own: summarizeTransportOutcomeBuckets(ownBuckets, window),
			reference:
				referenceBuckets === null
					? null
					: summarizeTransportOutcomeBuckets(referenceBuckets, window),
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
 *  - `medium` — two arms, above the bounce/deferral floors, but the engagement
 *               comparison's calibration slice is still too thin.
 *  - `high`   — two arms, every floor met.
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
	/** Sends observed on the own arm this window — the denominator behind the level. */
	readonly ownSample: number;
	/** The floor `ownSample` is measured against, so the UI never hard-codes 400. */
	readonly minSample: number;
}

export function dashboardConfidence(input: {
	readonly own: TransportOutcomeSummary;
	readonly reference: TransportOutcomeSummary | null;
	readonly hasSeedCoverage: boolean;
}): DashboardConfidence {
	const { own, reference, hasSeedCoverage } = input;
	const ownSample = own.sent;
	const minSample = RAMP_GATE_SAMPLE_FLOORS.engagement;
	const improvements: DashboardConfidenceImprovement[] = [];
	if (reference === null) improvements.push('connect_reference_transport');
	if (!hasSeedCoverage) improvements.push('add_seed_mailboxes');

	if (ownSample <= 0) {
		return { level: 'none', improvements, ownSample, minSample };
	}
	if (ownSample < RAMP_GATE_SAMPLE_FLOORS.hardBounce) improvements.push('send_more_volume');

	if (reference === null || ownSample < RAMP_GATE_SAMPLE_FLOORS.hardBounce) {
		return { level: 'low', improvements, ownSample, minSample };
	}
	const calibrated = own.calibrationSent >= minSample && reference.calibrationSent >= minSample;
	if (!calibrated && !improvements.includes('send_more_volume')) {
		improvements.push('send_more_volume');
	}
	return { level: calibrated ? 'high' : 'medium', improvements, ownSample, minSample };
}

// ============ CELL VIEW ============

export interface DashboardGateView {
	readonly gate: RampGateResult['gate'];
	readonly status: RampGateResult['status'];
	readonly reason: RampGateResult['reason'];
	/** The numbers that produced the verdict — rendered beside it, never re-derived. */
	readonly measurement: RampGateResult['measurement'];
}

export interface DashboardCellView {
	readonly cell: DeliverabilityCell;
	readonly cellKey: string;
	/** Fraction of the cell the own MTA carries, resolved through D1's helper. */
	readonly ownShare: number;
	readonly phaseCeiling: number | null;
	readonly cleanStreak: number;
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
		cleanStreak: evaluation.cleanStreak,
		own: input.own,
		reference: input.reference,
		verdict: evaluation.verdict,
		failedGate: evaluation.failedGate ?? null,
		requiresCorroboration: evaluation.requiresCorroboration,
		gates: evaluation.perGate.map((result) => ({
			gate: result.gate,
			status: result.status,
			reason: result.reason,
			measurement: result.measurement,
		})),
		confidence: dashboardConfidence({
			own: input.own,
			reference: input.reference,
			hasSeedCoverage: input.hasSeedCoverage,
		}),
		trend: input.trend,
	};
}
