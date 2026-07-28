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
import type { RampGateEvaluation } from '../ramp/gateTypes';
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
const AT_ENGAGEMENT_FLOOR = RAMP_GATE_SAMPLE_FLOORS.engagement;
const BELOW_ENGAGEMENT_FLOOR = RAMP_GATE_SAMPLE_FLOORS.engagement - 1;

interface ConfidenceCase {
	readonly name: string;
	readonly own: TransportOutcomeSummary;
	readonly reference: TransportOutcomeSummary | null;
	readonly hasSeedCoverage: boolean;
	readonly level: DashboardConfidenceLevel;
	readonly improvements: readonly DashboardConfidenceImprovement[];
}

const CONFIDENCE_CASES: readonly ConfidenceCase[] = [
	{
		name: 'nothing sent, standalone, no seeds — none, and both invitations',
		own: summary(),
		reference: null,
		hasSeedCoverage: false,
		level: 'none',
		improvements: ['connect_reference_transport', 'add_seed_mailboxes'],
	},
	{
		name: 'nothing sent with both a reference arm and seeds — still none, nothing to offer',
		own: summary(),
		reference: summary({ sent: 5000 }),
		hasSeedCoverage: true,
		level: 'none',
		improvements: [],
	},
	{
		name: 'standalone with plenty of volume — low, and only the relay invitation',
		own: summary({ sent: 100_000, calibrationSent: 100_000 }),
		reference: null,
		hasSeedCoverage: true,
		level: 'low',
		improvements: ['connect_reference_transport'],
	},
	{
		name: 'two arms but below the bounce floor — low, and asks for volume',
		own: summary({ sent: BELOW_BOUNCE_FLOOR }),
		reference: summary({ sent: BELOW_BOUNCE_FLOOR }),
		hasSeedCoverage: true,
		level: 'low',
		improvements: ['send_more_volume'],
	},
	{
		name: 'own arm is huge but the reference arm is a handful of sends — low, not medium',
		// The two-armed gates are all holding on `reference_sample_below_floor`
		// here, so anything above `low` would contradict the gate column (D14).
		own: summary({ sent: 5_000, calibrationSent: AT_ENGAGEMENT_FLOOR }),
		reference: summary({ sent: 2, calibrationSent: 0 }),
		hasSeedCoverage: true,
		level: 'low',
		improvements: ['send_more_volume'],
	},
	{
		name: 'reference arm one send below the bounce floor — still low',
		own: summary({ sent: 5_000, calibrationSent: AT_ENGAGEMENT_FLOOR }),
		reference: summary({ sent: BELOW_BOUNCE_FLOOR, calibrationSent: AT_ENGAGEMENT_FLOOR }),
		hasSeedCoverage: true,
		level: 'low',
		improvements: ['send_more_volume'],
	},
	{
		name: 'two arms above the bounce floor, calibration slice still thin — medium',
		own: summary({ sent: ABOVE_BOUNCE_FLOOR, calibrationSent: BELOW_ENGAGEMENT_FLOOR }),
		reference: summary({ sent: ABOVE_BOUNCE_FLOOR, calibrationSent: AT_ENGAGEMENT_FLOOR }),
		hasSeedCoverage: true,
		level: 'medium',
		improvements: ['send_more_volume'],
	},
	{
		name: 'two arms, own calibrated but the reference arm is not — still medium',
		own: summary({ sent: ABOVE_BOUNCE_FLOOR, calibrationSent: AT_ENGAGEMENT_FLOOR }),
		reference: summary({ sent: ABOVE_BOUNCE_FLOOR, calibrationSent: BELOW_ENGAGEMENT_FLOOR }),
		hasSeedCoverage: true,
		level: 'medium',
		improvements: ['send_more_volume'],
	},
	{
		name: 'two arms, both calibration slices at the floor — high, nothing to improve',
		own: summary({ sent: ABOVE_BOUNCE_FLOOR, calibrationSent: AT_ENGAGEMENT_FLOOR }),
		reference: summary({ sent: ABOVE_BOUNCE_FLOOR, calibrationSent: AT_ENGAGEMENT_FLOOR }),
		hasSeedCoverage: true,
		level: 'high',
		improvements: [],
	},
	{
		name: 'high measurement with no seeds — still high, seeds are an invitation not a gate (D2)',
		own: summary({ sent: ABOVE_BOUNCE_FLOOR, calibrationSent: AT_ENGAGEMENT_FLOOR }),
		reference: summary({ sent: ABOVE_BOUNCE_FLOOR, calibrationSent: AT_ENGAGEMENT_FLOOR }),
		hasSeedCoverage: false,
		level: 'high',
		improvements: ['add_seed_mailboxes'],
	},
];

describe('dashboardConfidence', () => {
	for (const testCase of CONFIDENCE_CASES) {
		it(testCase.name, () => {
			const result = dashboardConfidence({
				own: testCase.own,
				reference: testCase.reference,
				hasSeedCoverage: testCase.hasSeedCoverage,
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

	it('never asks for volume twice', () => {
		for (const reference of [
			summary({ sent: ABOVE_BOUNCE_FLOOR }),
			summary({ sent: BELOW_BOUNCE_FLOOR }),
		]) {
			const result = dashboardConfidence({
				own: summary({ sent: BELOW_BOUNCE_FLOOR }),
				reference,
				hasSeedCoverage: true,
			});
			expect(result.improvements.filter((code) => code === 'send_more_volume')).toHaveLength(1);
		}
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
			},
		],
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
			trend: [],
		});
		expect(view.cleanStreakIncludingThisWindow).toBe(evaluation.cleanStreak);
	});
});
