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
 * screen cannot disagree about how a number is DERIVED from a set of rows. WHICH
 * ROWS each is handed used to be a separate question and is no longer: the
 * verdicts on a cell view are reached over the controller's own evaluation
 * window, and the counters beside them are reported over
 * `DASHBOARD_WINDOW_DAYS`, with the query naming both spans on the wire (#510).
 * This module groups buckets into days, hands each day's rows to that
 * summarizer, and labels the result. If you find yourself typing `/` next to a
 * counter in this file, you are writing the bug D5 exists to prevent.
 *
 * CONFIDENCE (plan D14) COMES FROM THE EVALUATOR, NOT FROM HERE. The grade this
 * module starts from is `RampGateEvaluation.measuredConfidence` — the weakest
 * level among the gates that actually DECIDED something, produced by the same
 * pure core the controller runs. Two judgements are layered on top of it here,
 * and BOTH are about what the deployment could not measure rather than about
 * any rate: `none` when nothing was sent, and the cap by the missing
 * instruments. That is why the two levels are NAMED APART — the evaluation's
 * number grades the DECISION (and is what the D12 audit row records), the level
 * this module produces grades the CELL (and is what the screen renders). See
 * `dashboardConfidence` and `RampGateEvaluation.measuredConfidence`.
 *
 * A placeholder used to derive the level here from (is there a second arm) plus
 * (is the sample above the floors). It was replaced rather than extended,
 * because a healthy standalone cell graded `medium` by the decision core and
 * `low` by the screen is the controller and the dashboard disagreeing about a
 * number — the exact failure the D5 single-derivation rule exists to prevent,
 * landing in the one configuration D14 says must be told the truth.
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
import type { RampGateConfidence, RampGateEvaluation, RampGateResult } from './ramp/gateTypes';
import { RAMP_GATE_SAMPLE_FLOORS } from './ramp/gateConfig';
import { weakestConfidence } from './ramp/gateGrades';
import { DAY_MS } from '../lib/constants';

/** Declared ONCE for the whole feature; the query shell imports it from here. */

/** How many days of trend the screen renders at most — one bounded series. */
export const DASHBOARD_MAX_TREND_DAYS = 30;

// ============ WINDOW ============

/**
 * The span this screen REPORTS over, and NOT caller-negotiable.
 *
 * Deliberately NOT the controller's cadence, which is one day
 * (`RAMP_AIMD.evaluationWindowMs`) — and deliberately not what any VERDICT on
 * this screen is decided over either. Both arms are summarized a second time
 * over the controller's span before they reach the evaluator, so the two readers
 * agree on the verdict (#510); this constant governs the counters, the rates,
 * the trend and the confidence cap rendered beside it, which plan D2/D5 asks for
 * over a week rather than over a day.
 */
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
 * How much this cell's measurement is worth — `RampGateConfidence` plus the one
 * state a gate never has to describe.
 *
 *  - `none`   — nothing was sent in the window. Not a problem, not a warning;
 *               the gates all held, and grading a held window would put a
 *               confidence beside no measurement at all.
 *  - `low`    — the weakest contributing gate was a weak signal (the standalone
 *               trailing-baseline engagement check). The ramp still moves; it
 *               just may not move UP on that evidence (plan D14).
 *  - `medium` — the weakest contributing gate was a proxy or a tripwire: the
 *               one-click unsubscribe stand-in for a feedback loop, or a seed
 *               sweep. Real evidence, honestly labelled as second-hand.
 *  - `high`   — everything that contributed was measured on our own wire.
 */
export type DashboardConfidenceLevel = 'none' | RampGateConfidence;

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

/**
 * TRANSLATE, DO NOT RE-DERIVE. The level starts as the evaluator's own
 * `weakestConfidence` fold over the gates that actually DECIDED something
 * (`RampGateEvaluation.measuredConfidence`) — with exactly two judgements
 * layered on top, both of them about what was NOT measured rather than about
 * any rate:
 *
 *   1. a window with nothing in it is graded `none`, rather than being given
 *      whichever level a column of holds happened to produce;
 *   2. a cell is CAPPED by the measurement inputs it does not have, which is
 *      plan D14's sentence read literally: "measurement confidence: low —
 *      connect a relay or add seed mailboxes to improve". With NEITHER of those
 *      the cap is `low`; with seeds but no second arm it is `medium`; a cell
 *      with a reference arm has no cap, so absent seeds beside one remain an
 *      invitation rather than a downgrade (plan D2).
 *
 *      This is not pessimism about the gates that DID decide — a standalone
 *      bounce gate really is high-confidence direct measurement, and it still
 *      says so on its own row. It is honesty about the CELL: with no second arm
 *      and no view of the spam folder there is no way to tell a degradation from
 *      a bad week for the whole list, and an operator reading "high" beside a
 *      column of "not enough data yet" has been told something false.
 *
 * THE SIGNATURE IS THE GUARD. It takes the five facts it is allowed to use and
 * not the outcome summaries, so re-deriving a level from rates — which is what
 * the placeholder this replaced did — is not reachable from here.
 *
 * `ownSent` IS THE REPORTED WINDOW'S SAMPLE, not the deciding span's. This is a
 * judgement about the CELL rendered beside the cell's own counters: "nothing sent
 * yet" has to mean the week the card is showing, and `send_more_volume` invites
 * an operator to fill a week rather than a day (#510). The LEVEL it starts from
 * is still the evaluator's, over the deciding span.
 *
 * The IMPROVEMENT CODES are this module's, because they are the one thing the
 * evaluator does not answer: it grades what it measured, and these name what an
 * operator could add to make the next grade better. They are advice and never a
 * warning (plan D2) — `connect_reference_transport` is offered to a supported
 * configuration, not to an incomplete one.
 *
 * WHICH IS WHY THE CAP AND THE OFFER TAKE DIFFERENT INPUTS. The cap is about
 * this cell's WINDOW — a cell no relay carried was not compared against
 * anything, whatever the deployment owns, so `hasReferenceArm` (the measurement)
 * caps it. The offer is about the DEPLOYMENT: "connect a relay you already pay
 * for" is advice nobody with a relay connected can act on, and keying it to the
 * measurement would show it on any cell an existing relay happened not to carry
 * in the last day — flickering on and off day to day on a low-volume cell of a
 * fully relayed deployment. So the offer is keyed to `hasRelayConfigured`, and a
 * connected-but-idle relay caps the level without asking for a second one.
 */
export function dashboardConfidence(input: {
	readonly ownSent: number;
	readonly hasReferenceArm: boolean;
	readonly hasRelayConfigured: boolean;
	readonly hasSeedCoverage: boolean;
	readonly evaluated: RampGateConfidence;
}): DashboardConfidence {
	const { ownSent, hasReferenceArm, hasRelayConfigured, hasSeedCoverage, evaluated } = input;
	const improvements: DashboardConfidenceImprovement[] = [];
	if (!hasRelayConfigured) improvements.push('connect_reference_transport');
	if (!hasSeedCoverage) improvements.push('add_seed_mailboxes');

	if (ownSent <= 0) return { level: 'none', improvements };
	// A cell whose gates are holding for want of volume is told the one thing
	// that would unhold them. The LEVEL still comes from the evaluator — this
	// only adds the advice beside it.
	if (ownSent < RAMP_GATE_SAMPLE_FLOORS.hardBounce) improvements.push('send_more_volume');

	const ceiling: RampGateConfidence = hasReferenceArm ? 'high' : hasSeedCoverage ? 'medium' : 'low';
	return { level: weakestConfidence([evaluated, ceiling]), improvements };
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
	/**
	 * THE REPORTED ARMS — every counter and rate summarized over the query's
	 * `windowStart`/`windowEnd` (`DASHBOARD_WINDOW_DAYS`). NOT the summaries the
	 * verdict below was reached over: those are the controller's span, which the
	 * query names separately as `decisionWindowStart`/`decisionWindowEnd`, and a
	 * screen that renders these two side by side has to say which is which (#510).
	 */
	readonly own: TransportOutcomeSummary;
	/**
	 * `null` = standalone cell (D2), rendered with its confidence caveat — and
	 * `null` exactly when the DECIDING span found no reference arm, so the column
	 * is present precisely when the verdict was graded against a second arm.
	 */
	readonly reference: TransportOutcomeSummary | null;
	/**
	 * THE DECIDED FIELDS — verdict, failed gate, corroboration and every per-gate
	 * `measurement` are the evaluator's, over the DECIDING span. They are the
	 * controller's own verdicts on the same rows, not this screen's re-derivation
	 * of them over a week (#510).
	 */
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
 *
 * TWO SPANS ARRIVE HERE AND NEITHER IS DERIVED HERE: `own`/`reference` are the
 * REPORTED window's summaries and `evaluation` carries the DECIDING span's
 * verdicts. Keeping them separate arguments is what lets the shell hand each
 * consumer the right one — the confidence denominator takes the reported sample
 * (plan D2/D5), the gate rows take the evaluator's (#510).
 */
export function buildDashboardCellView(input: {
	readonly cell: DeliverabilityCell;
	readonly cellKey: string;
	readonly ownShare: number;
	readonly phaseCeiling: number | null;
	/** The REPORTED window's arms — never the ones the evaluator graded. */
	readonly own: TransportOutcomeSummary;
	readonly reference: TransportOutcomeSummary | null;
	/** The evaluator's answer over the DECIDING span (the controller's). */
	readonly evaluation: RampGateEvaluation;
	readonly hasSeedCoverage: boolean;
	/** MEASUREMENT: did a relay carry THIS cell in the controller's span. */
	readonly hasReferenceArm: boolean;
	/** CONFIGURATION: does the deployment own a relay at all. */
	readonly hasRelayConfigured: boolean;
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
			ownSent: input.own.sent,
			hasReferenceArm: input.hasReferenceArm,
			hasRelayConfigured: input.hasRelayConfigured,
			hasSeedCoverage: input.hasSeedCoverage,
			evaluated: evaluation.measuredConfidence,
		}),
		trend: input.trend,
	};
}
