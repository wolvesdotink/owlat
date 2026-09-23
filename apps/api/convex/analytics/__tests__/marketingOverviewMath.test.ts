import { describe, expect, it } from 'vitest';
import {
	WEEK_MS,
	denseDailyOpens,
	engagementRates,
	inWindow,
	periodTotals,
	safeRate,
	sendingProgress,
	utcDateKey,
	weeklyTotals,
	weightedAverageRates,
	type DatedCampaignCounts,
} from '../marketingOverviewMath';

function counts(overrides: Partial<DatedCampaignCounts> = {}): DatedCampaignCounts {
	return {
		sentAt: 0,
		sent: 0,
		delivered: 0,
		opened: 0,
		clicked: 0,
		unsubscribed: 0,
		bounced: 0,
		...overrides,
	};
}

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

describe('safeRate / engagementRates', () => {
	it('is 0 instead of NaN when nothing was delivered', () => {
		expect(safeRate(5, 0)).toBe(0);
		expect(engagementRates(counts({ opened: 3, clicked: 1 }))).toEqual({
			openRate: 0,
			clickRate: 0,
			unsubscribeRate: 0,
		});
	});

	it('divides opens, clicks and unsubscribes by delivered', () => {
		expect(
			engagementRates(counts({ delivered: 200, opened: 80, clicked: 10, unsubscribed: 2 }))
		).toEqual({ openRate: 0.4, clickRate: 0.05, unsubscribeRate: 0.01 });
	});
});

describe('weightedAverageRates', () => {
	it('weights by delivered, so a tiny send cannot swing the average', () => {
		const avg = weightedAverageRates([
			counts({ delivered: 10, opened: 10 }), // 100%
			counts({ delivered: 990, opened: 198 }), // 20%
		]);
		expect(avg.openRate).toBeCloseTo(0.208, 6);
	});

	it('is all zeros for no campaigns', () => {
		expect(weightedAverageRates([])).toEqual({ openRate: 0, clickRate: 0, unsubscribeRate: 0 });
	});
});

describe('periodTotals', () => {
	it('sums delivered and takes the bounce rate over sent', () => {
		const totals = periodTotals([
			counts({ sent: 100, delivered: 95, bounced: 5, opened: 38, clicked: 5, unsubscribed: 1 }),
			counts({ sent: 100, delivered: 99, bounced: 1, opened: 40, clicked: 7, unsubscribed: 0 }),
		]);
		expect(totals.delivered).toBe(194);
		expect(totals.bounceRate).toBeCloseTo(0.03, 6);
		expect(totals.openRate).toBeCloseTo(78 / 194, 6);
		expect(totals.clickRate).toBeCloseTo(12 / 194, 6);
		expect(totals.unsubscribeRate).toBeCloseTo(1 / 194, 6);
	});
});

describe('inWindow', () => {
	it('is half-open, so a boundary campaign lands in exactly one window', () => {
		const rows = [counts({ sentAt: 10 }), counts({ sentAt: 20 }), counts({ sentAt: 30 })];
		expect(inWindow(rows, 10, 20).map((r) => r.sentAt)).toEqual([10]);
		expect(inWindow(rows, 20, 31).map((r) => r.sentAt)).toEqual([20, 30]);
	});
});

describe('weeklyTotals', () => {
	it('returns `weeks` buckets oldest first, the last one being the trailing week', () => {
		const rows = [
			counts({ sentAt: NOW - 1000, delivered: 10, opened: 5 }),
			counts({ sentAt: NOW - WEEK_MS - 1000, delivered: 20, opened: 2 }),
			counts({ sentAt: NOW - 11 * WEEK_MS - 1000, delivered: 40, opened: 4 }),
			// Older than the 12-week window: ignored.
			counts({ sentAt: NOW - 12 * WEEK_MS - 1000, delivered: 1000, opened: 1000 }),
		];
		const weeks = weeklyTotals(rows, NOW, 12);
		expect(weeks).toHaveLength(12);
		expect(weeks[11]!.delivered).toBe(10);
		expect(weeks[11]!.openRate).toBe(0.5);
		expect(weeks[10]!.delivered).toBe(20);
		expect(weeks[0]!.delivered).toBe(40);
		expect(weeks.slice(1, 10).every((w) => w.delivered === 0)).toBe(true);
	});
});

describe('denseDailyOpens', () => {
	it('fills quiet days with zeros and ends today (UTC)', () => {
		const today = utcDateKey(NOW);
		const threeDaysAgo = utcDateKey(NOW - 3 * 24 * 60 * 60 * 1000);
		const series = denseDailyOpens(
			[
				{ date: threeDaysAgo, opened: 7 },
				{ date: today, opened: 2 },
			],
			30,
			NOW
		);
		expect(series).toHaveLength(30);
		expect(series[29]).toEqual({ date: today, opened: 2 });
		expect(series[26]).toEqual({ date: threeDaysAgo, opened: 7 });
		expect(series.reduce((sum, d) => sum + d.opened, 0)).toBe(9);
	});

	it('formats keys as zero-padded UTC dates', () => {
		expect(utcDateKey(Date.UTC(2026, 0, 5, 23, 59))).toBe('2026-01-05');
	});
});

describe('sendingProgress', () => {
	it('is undefined without a send walk', () => {
		expect(sendingProgress(10, null)).toBeUndefined();
	});

	it('uses the enqueued count once every recipient is enqueued', () => {
		expect(sendingProgress(25, { phase: 'done', enqueuedCount: 100 })).toBe(0.25);
	});

	it('uses an exact planned total while the walk is still resolving', () => {
		expect(sendingProgress(50, { phase: 'resolving', enqueuedCount: 60, plannedTotal: 200 })).toBe(
			0.25
		);
	});

	it('refuses a lower-bound total — a floor would overstate progress', () => {
		expect(
			sendingProgress(50, {
				phase: 'resolving',
				enqueuedCount: 60,
				plannedTotal: 200,
				isPlannedTotalLowerBound: true,
			})
		).toBeUndefined();
		expect(sendingProgress(50, { phase: 'resolving', enqueuedCount: 60 })).toBeUndefined();
	});

	it('clamps to 1', () => {
		expect(sendingProgress(120, { phase: 'done', enqueuedCount: 100 })).toBe(1);
	});
});
