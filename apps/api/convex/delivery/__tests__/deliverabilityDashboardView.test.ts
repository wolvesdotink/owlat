/**
 * The deliverability dashboard's PURE view assembly — the fixture matrix.
 *
 * These are the decision functions the screen's honesty rests on, and none of
 * them touches a clock or a database, so they are tested here exhaustively
 * rather than through the convex harness (plan D15). Three properties:
 *
 *   - CONFIDENCE reaches every level it declares and emits every improvement
 *     code it declares. The web copy has a sentence for each code; a level or a
 *     code that no server input can produce is either dead or a lie;
 *   - the TREND survives degenerate bounds — non-finite, inverted, and a span
 *     far wider than the cap — because a poisoned number must not blank or
 *     unbound a screen;
 *   - the WINDOW's two sub-windows are DISJOINT. Gate 4b's baseline exists to
 *     catch a slow decay, and a baseline that overlaps the recent window has
 *     already been dragged down by that decay.
 */

import { describe, expect, it } from 'vitest';
import {
	summarizeTransportOutcomeBuckets,
	ZERO_TRANSPORT_OUTCOME_TOTALS,
	type TransportOutcomeBucketCounts,
	type TransportOutcomeSummary,
} from '../../analytics/transportOutcomeSummary';
import { RAMP_GATE_SAMPLE_FLOORS } from '../ramp/gateConfig';
import { DIRECT_MEASUREMENT } from '../ramp/gateGrades';
import type { RampGateConfidence, RampGateEvaluation } from '../ramp/gateTypes';
import {
	buildDashboardCellView,
	buildDashboardTrend,
	dashboardConfidence,
	dashboardWindow,
	DASHBOARD_MAX_TREND_DAYS,
	DASHBOARD_WINDOW_DAYS,
	DAY_MS,
	type DashboardConfidenceImprovement,
	type DashboardConfidenceLevel,
} from '../deliverabilityDashboardView';

/** A summary built the ONE legal way: through the summarizer (plan D5). */
function summary(overrides: Partial<TransportOutcomeBucketCounts> = {}): TransportOutcomeSummary {
	return summarizeTransportOutcomeBuckets([
		{ ...ZERO_TRANSPORT_OUTCOME_TOTALS, periodStart: 0, lastRecordedAt: 0, ...overrides },
	]);
}

function bucket(
	periodStart: number,
	overrides: Partial<TransportOutcomeBucketCounts> = {}
): TransportOutcomeBucketCounts {
	return {
		...ZERO_TRANSPORT_OUTCOME_TOTALS,
		periodStart,
		lastRecordedAt: periodStart,
		...overrides,
	};
}

// ============ CONFIDENCE (D14) ============

const ABOVE_BOUNCE_FLOOR = RAMP_GATE_SAMPLE_FLOORS.hardBounce + 1;
const BELOW_BOUNCE_FLOOR = RAMP_GATE_SAMPLE_FLOORS.hardBounce - 1;

/**
 * THE LEVEL IS THE EVALUATOR'S, NOT THE SCREEN'S.
 *
 * `dashboardConfidence` translates `RampGateEvaluation.measuredConfidence` and adds the
 * improvement codes; it never re-derives a level from the arms or the sample.
 * That is the whole point of the table below: the same traffic with a different
 * `evaluated` grade renders a different level, and the same `evaluated` grade
 * with different traffic renders the same one.
 */
interface ConfidenceCase {
	readonly name: string;
	readonly ownSent: number;
	readonly hasReferenceArm: boolean;
	readonly hasSeedCoverage: boolean;
	readonly evaluated: RampGateConfidence;
	readonly level: DashboardConfidenceLevel;
	readonly improvements: readonly DashboardConfidenceImprovement[];
}

const CONFIDENCE_CASES: readonly ConfidenceCase[] = [
	{
		name: 'nothing sent, standalone, no seeds — none, and both invitations',
		ownSent: 0,
		hasReferenceArm: false,
		// An evaluation nothing contributed to grades `low`; a window with no
		// traffic in it is still reported as `none`, because a confidence beside no
		// measurement at all is a number nobody should read.
		evaluated: 'low',
		hasSeedCoverage: false,
		level: 'none',
		improvements: ['connect_reference_transport', 'add_seed_mailboxes'],
	},
	{
		name: 'nothing sent with both a reference arm and seeds — still none, nothing to offer',
		ownSent: 0,
		hasReferenceArm: true,
		evaluated: 'high',
		hasSeedCoverage: true,
		level: 'none',
		improvements: [],
	},
	{
		name: 'a healthy STANDALONE cell reaches the wire at the MEDIUM the evaluator graded it',
		// The configuration the whole confidence model exists for: no reference arm,
		// gate 3 on the unsubscribe proxy, so the weakest contributor is `medium`.
		ownSent: 100_000,
		hasReferenceArm: false,
		evaluated: 'medium',
		hasSeedCoverage: true,
		level: 'medium',
		improvements: ['connect_reference_transport'],
	},
	{
		name: 'a standalone cell graded LOW is not upgraded on its way to the screen',
		ownSent: 100_000,
		hasReferenceArm: false,
		evaluated: 'low',
		hasSeedCoverage: true,
		level: 'low',
		improvements: ['connect_reference_transport'],
	},
	{
		name: 'a STANDALONE cell whose gates all graded HIGH is still capped at medium (D14)',
		// THE REGRESSION THIS TABLE EXISTS FOR. A one-armed cell whose only DECIDED
		// gate is the (genuinely high-confidence) deferral check must not tell the
		// operator the cell is well-measured: there is no second arm, and the screen
		// says so.
		ownSent: 100_000,
		hasReferenceArm: false,
		evaluated: 'high',
		hasSeedCoverage: true,
		level: 'medium',
		improvements: ['connect_reference_transport'],
	},
	{
		name: 'a thin window keeps the evaluator’s level and gains only the volume advice',
		ownSent: BELOW_BOUNCE_FLOOR,
		hasReferenceArm: true,
		evaluated: 'high',
		hasSeedCoverage: true,
		level: 'high',
		improvements: ['send_more_volume'],
	},
	{
		name: 'two arms, everything measured on our own wire — high, nothing to improve',
		ownSent: ABOVE_BOUNCE_FLOOR,
		hasReferenceArm: true,
		evaluated: 'high',
		hasSeedCoverage: true,
		level: 'high',
		improvements: [],
	},
	{
		name: 'high measurement with no seeds — still high, seeds are an invitation not a gate (D2)',
		ownSent: ABOVE_BOUNCE_FLOOR,
		hasReferenceArm: true,
		evaluated: 'high',
		hasSeedCoverage: false,
		level: 'high',
		improvements: ['add_seed_mailboxes'],
	},
];

describe('dashboardConfidence', () => {
	for (const testCase of CONFIDENCE_CASES) {
		it(testCase.name, () => {
			const result = dashboardConfidence({
				ownSent: testCase.ownSent,
				hasReferenceArm: testCase.hasReferenceArm,
				hasSeedCoverage: testCase.hasSeedCoverage,
				evaluated: testCase.evaluated,
			});
			expect(result.level).toBe(testCase.level);
			expect([...result.improvements].sort()).toEqual([...testCase.improvements].sort());
		});
	}

	it('reaches every level it declares', () => {
		const reached = new Set(CONFIDENCE_CASES.map((testCase) => testCase.level));
		expect([...reached].sort()).toEqual(['high', 'low', 'medium', 'none']);
	});

	it('emits every improvement code it declares — none of them is dead copy', () => {
		const emitted = new Set(CONFIDENCE_CASES.flatMap((testCase) => [...testCase.improvements]));
		expect([...emitted].sort()).toEqual([
			'add_seed_mailboxes',
			'connect_reference_transport',
			'send_more_volume',
		]);
	});

	it('passes EVERY grade through unchanged on a two-armed cell', () => {
		for (const evaluated of ['low', 'medium', 'high'] as const) {
			const result = dashboardConfidence({
				ownSent: ABOVE_BOUNCE_FLOOR,
				hasReferenceArm: true,
				hasSeedCoverage: true,
				evaluated,
			});
			expect(result.level).toBe(evaluated);
		}
	});

	it('never renders HIGH for a cell with no reference arm, whatever the gates graded', () => {
		for (const evaluated of ['low', 'medium', 'high'] as const) {
			for (const hasSeedCoverage of [true, false]) {
				const result = dashboardConfidence({
					ownSent: ABOVE_BOUNCE_FLOOR,
					hasReferenceArm: false,
					hasSeedCoverage,
					evaluated,
				});
				expect(result.level).not.toBe('high');
			}
		}
	});

	it('reads D14’s sentence literally: neither input present caps the cell at LOW', () => {
		const result = dashboardConfidence({
			ownSent: ABOVE_BOUNCE_FLOOR,
			hasReferenceArm: false,
			hasSeedCoverage: false,
			evaluated: 'high',
		});
		expect(result.level).toBe('low');
		expect([...result.improvements].sort()).toEqual([
			'add_seed_mailboxes',
			'connect_reference_transport',
		]);
	});

	it('never asks for volume twice', () => {
		const result = dashboardConfidence({
			ownSent: BELOW_BOUNCE_FLOOR,
			hasReferenceArm: true,
			hasSeedCoverage: true,
			evaluated: 'high',
		});
		expect(result.improvements.filter((code) => code === 'send_more_volume')).toHaveLength(1);
	});
});

// ============ TREND ============

describe('buildDashboardTrend', () => {
	const day = Date.UTC(2026, 6, 15);

	it('emits one point per day, each derived by the summarizer over that day only', () => {
		const rows = [bucket(day, { sent: 10 }), bucket(day + DAY_MS, { sent: 4 })];
		const points = buildDashboardTrend({
			ownBuckets: rows,
			referenceBuckets: null,
			sinceDay: day,
			untilDay: day + 3 * DAY_MS,
		});
		expect(points.map((point) => point.day)).toEqual([day, day + DAY_MS, day + 2 * DAY_MS]);
		expect(points[0]?.own).toEqual(
			summarizeTransportOutcomeBuckets(rows, { since: day, until: day + DAY_MS })
		);
		// A quiet day is still a point, and it is a ZEROED summary, not a hole.
		expect(points[2]?.own.sent).toBe(0);
		expect(points.every((point) => point.reference === null)).toBe(true);
	});

	it('carries the reference arm as its own series when there is one', () => {
		const points = buildDashboardTrend({
			ownBuckets: [bucket(day, { sent: 10 })],
			referenceBuckets: [bucket(day, { sent: 7 })],
			sinceDay: day,
			untilDay: day + DAY_MS,
		});
		expect(points[0]?.own.sent).toBe(10);
		expect(points[0]?.reference?.sent).toBe(7);
	});

	it('sums every shard of the same day into that day’s point', () => {
		const points = buildDashboardTrend({
			ownBuckets: [bucket(day, { sent: 10 }), bucket(day, { sent: 5 })],
			referenceBuckets: null,
			sinceDay: day,
			untilDay: day + DAY_MS,
		});
		expect(points[0]?.own.sent).toBe(15);
	});

	it('clamps a span far wider than the cap to the cap', () => {
		const points = buildDashboardTrend({
			ownBuckets: [],
			referenceBuckets: null,
			sinceDay: day,
			untilDay: day + 400 * DAY_MS,
		});
		expect(points).toHaveLength(DASHBOARD_MAX_TREND_DAYS);
	});

	for (const [name, bounds] of [
		['an inverted window', { sinceDay: day + DAY_MS, untilDay: day }],
		['a zero-width window', { sinceDay: day, untilDay: day }],
		['a NaN start', { sinceDay: Number.NaN, untilDay: day }],
		['a NaN end', { sinceDay: day, untilDay: Number.NaN }],
		['an infinite start', { sinceDay: -Infinity, untilDay: day }],
		['an infinite end', { sinceDay: day, untilDay: Infinity }],
	] as const) {
		it(`returns an empty series for ${name} rather than an unbounded one`, () => {
			expect(
				buildDashboardTrend({
					ownBuckets: [bucket(day, { sent: 10 })],
					referenceBuckets: null,
					...bounds,
				})
			).toEqual([]);
		});
	}

	it('ignores a row whose bucket day is not a finite number', () => {
		const points = buildDashboardTrend({
			ownBuckets: [bucket(Number.NaN, { sent: 999 }), bucket(day, { sent: 3 })],
			referenceBuckets: null,
			sinceDay: day,
			untilDay: day + DAY_MS,
		});
		expect(points[0]?.own.sent).toBe(3);
	});
});

// ============ WINDOW ============

describe('dashboardWindow', () => {
	const now = Date.UTC(2026, 6, 15, 13, 47, 12);

	it('spans the ramp’s cadence and ends at the end of the current UTC day', () => {
		const window = dashboardWindow(now);
		expect(window.untilDay).toBe(Date.UTC(2026, 6, 16));
		expect(window.untilDay - window.sinceDay).toBe(DASHBOARD_WINDOW_DAYS * DAY_MS);
	});

	it('keeps the trailing baseline DISJOINT from the evaluation window', () => {
		// The property gate 4b's slow-poison floor is contracted on: a baseline
		// that overlapped the recent window would already carry the decay it is
		// supposed to detect.
		for (const offsetHours of [0, 1, 13, 23]) {
			const window = dashboardWindow(now + offsetHours * 60 * 60 * 1000);
			expect(window.baselineUntilDay).toBe(window.sinceDay);
			expect(window.baselineSinceDay).toBeLessThan(window.baselineUntilDay);
		}
	});

	it('reads far enough back to cover the baseline in one index read', () => {
		const window = dashboardWindow(now);
		expect(window.readSinceDay).toBeLessThanOrEqual(window.baselineSinceDay);
		expect(window.readSinceDay).toBeLessThanOrEqual(window.sinceDay);
		// And no further than the trend cap the screen renders plus the baseline.
		expect(window.untilDay - window.readSinceDay).toBe(30 * DAY_MS);
	});

	it('is stable across a day — every call within one UTC day agrees', () => {
		expect(dashboardWindow(Date.UTC(2026, 6, 15, 0, 0, 0))).toEqual(
			dashboardWindow(Date.UTC(2026, 6, 15, 23, 59, 59, 999))
		);
	});
});

// ============ CELL VIEW ============

describe('buildDashboardCellView', () => {
	const evaluation: RampGateEvaluation = {
		verdict: 'pass',
		requiresCorroboration: false,
		cleanStreak: 3,
		perGate: [
			{
				gate: 'hard_bounce',
				status: 'pass',
				reason: 'within_threshold',
				measurement: {
					thresholdRate: 0.02,
					toleranceValuePp: 0.5,
					ownSample: 1000,
					referenceSample: 900,
					minSample: 200,
					ownRate: 0.004,
					referenceRate: 0.003,
				},
				...DIRECT_MEASUREMENT,
			},
		],
		measuredConfidence: 'high',
		increaseEvidence: true,
		evaluatedAt: 1,
	};

	it('copies the summarizer’s numbers rather than recomputing any of them', () => {
		const own = summary({ sent: 1000, delivered: 980, hardBounced: 10 });
		const view = buildDashboardCellView({
			cell: { stream: 'campaign', destinationProvider: 'gmail' },
			cellKey: 'campaign:gmail',
			ownShare: 0.25,
			phaseCeiling: 0.5,
			own,
			reference: null,
			evaluation,
			hasSeedCoverage: false,
			hasReferenceArm: false,
			trend: [],
		});
		expect(view.own).toBe(own);
		// The gate results travel WHOLE, so `status` still discriminates `reason`
		// and `measurement` on the wire.
		expect(view.gates).toBe(evaluation.perGate);
		expect(view.failedGate).toBeNull();
	});

	it('reports the evaluator’s streak, which INCLUDES the window on screen', () => {
		const view = buildDashboardCellView({
			cell: { stream: 'automation', destinationProvider: 'yahoo' },
			cellKey: 'automation:yahoo',
			ownShare: 1,
			phaseCeiling: null,
			own: summary({ sent: 10 }),
			reference: null,
			evaluation,
			hasSeedCoverage: false,
			hasReferenceArm: false,
			trend: [],
		});
		expect(view.cleanStreakIncludingThisWindow).toBe(evaluation.cleanStreak);
	});

	/**
	 * THE CELL-LEVEL NUMBER THE UI RENDERS IS THE EVALUATOR'S (plan D5, D14).
	 *
	 * A healthy standalone cell is graded `medium` by the decision core — gate 3
	 * is running the unsubscribe proxy, which is the weakest link. The screen must
	 * report that same `medium`; the placeholder it replaced said `low`, and a
	 * controller and a dashboard that disagree about a number is the D5 failure
	 * mode landing in the one configuration D14 says to tell the truth to.
	 */
	it('carries a standalone evaluation’s MEDIUM to the wire, and does not upgrade a LOW', () => {
		for (const graded of ['medium', 'low'] as const satisfies readonly RampGateConfidence[]) {
			const view = buildDashboardCellView({
				cell: { stream: 'campaign', destinationProvider: 'gmail' },
				cellKey: 'campaign:gmail',
				ownShare: 1,
				phaseCeiling: null,
				own: summary({ sent: 50_000, delivered: 49_000 }),
				// Standalone: the configuration the old heuristic pinned at `low`
				// regardless of what the gates actually measured.
				reference: null,
				evaluation: { ...evaluation, measuredConfidence: graded },
				hasSeedCoverage: true,
				hasReferenceArm: false,
				trend: [],
			});
			expect(view.confidence.level).toBe(graded);
			expect(view.confidence.improvements).toContain('connect_reference_transport');
		}
	});
});
