/**
 * THE TRAILING-7-DAY PROJECTION, over the shapes real cells actually take.
 *
 * A cell's demand is never a smooth series: a campaign is a spike, a paused week
 * is zeros, a growing list is a genuine trend, and a brand-new cell is nothing at
 * all. The statistic has to tell those apart, because the projection is the
 * DENOMINATOR of the capacity ceiling — under-project and the controller promises
 * the own MTA volume its warming cap cannot carry.
 */

import { describe, expect, it } from 'vitest';
import { startOfDayUtc } from '../../../lib/clock';
import { projectCellVolume, type CellVolumeDay } from '../capacityProjection';
import { DAY, NOW } from './controllerFixtures';

/** Whole UTC day starts, oldest first, for the seven COMPLETE days before NOW. */
function trailingDays(totals: readonly number[], owns?: readonly number[]): CellVolumeDay[] {
	const today = startOfDayUtc(NOW);
	return totals.map((total, index) => ({
		dayStartMs: today - (totals.length - index) * DAY,
		total,
		own: owns?.[index] ?? total,
	}));
}

function projected(totals: readonly number[]): { dailyVolume: number; observedDays: number } {
	const projection = projectCellVolume(trailingDays(totals), NOW);
	if (projection.kind !== 'projected') {
		throw new Error(`expected a projection, got ${projection.reason}`);
	}
	return { dailyVolume: projection.dailyVolume, observedDays: projection.observedDays };
}

describe('projectCellVolume over trailing fixtures', () => {
	it('projects a STEADY week as itself', () => {
		expect(projected([1000, 1000, 1000, 1000, 1000, 1000, 1000])).toEqual({
			dailyVolume: 1000,
			observedDays: 7,
		});
	});

	it('TRACKS GROWTH: a growing week projects above the week median, not at it', () => {
		// Weekly median 400; the last three days median 600. The recent window leads.
		const { dailyVolume } = projected([100, 200, 300, 400, 500, 600, 700]);
		expect(dailyVolume).toBe(600);
	});

	it('a SINGLE SPIKE is not a trend — mid-week', () => {
		expect(projected([100, 100, 100, 5000, 100, 100, 100]).dailyVolume).toBe(100);
	});

	it('a SINGLE SPIKE is not a trend — yesterday, where a mean would swallow it', () => {
		// A mean of the last three days would read 1733 off one outlier and cut the
		// ceiling by a factor of seventeen. A median of three cannot be moved by one.
		expect(projected([100, 100, 100, 100, 100, 100, 5000]).dailyVolume).toBe(100);
	});

	it('a BURSTY week lands between its quiet and its loud days', () => {
		const { dailyVolume } = projected([100, 2000, 100, 2000, 100, 2000, 100]);
		expect(dailyVolume).toBeGreaterThanOrEqual(100);
		expect(dailyVolume).toBeLessThan(2000);
	});

	it('a PAUSED week projects nothing at all rather than zero', () => {
		expect(projectCellVolume(trailingDays([0, 0, 0, 0, 0, 0, 0]), NOW)).toEqual({
			kind: 'unknown',
			reason: 'no_volume',
		});
	});

	it('a BRAND-NEW cell with no history is unknown, never zero', () => {
		expect(projectCellVolume([], NOW)).toEqual({ kind: 'unknown', reason: 'no_history' });
	});

	it("a cell that only started yesterday projects yesterday's volume", () => {
		const today = startOfDayUtc(NOW);
		const projection = projectCellVolume([{ dayStartMs: today - DAY, total: 900, own: 300 }], NOW);
		expect(projection).toMatchObject({ kind: 'projected', dailyVolume: 900, observedDays: 1 });
	});

	it("EXCLUDES today's partial day — a half-counted morning is not a low day", () => {
		const today = startOfDayUtc(NOW);
		const projection = projectCellVolume(
			[
				...trailingDays([1000, 1000, 1000, 1000, 1000, 1000, 1000]),
				{
					dayStartMs: today,
					total: 5,
					own: 5,
				},
			],
			NOW
		);
		expect(projection).toMatchObject({ dailyVolume: 1000, observedDays: 7 });
	});

	it('EXCLUDES days older than the trailing window', () => {
		const today = startOfDayUtc(NOW);
		const projection = projectCellVolume(
			[
				{ dayStartMs: today - 30 * DAY, total: 100_000, own: 100_000 },
				...trailingDays([1000, 1000, 1000]),
			],
			NOW
		);
		expect(projection).toMatchObject({ dailyVolume: 1000, observedDays: 3 });
	});

	it('AGGREGATES per-shard rows for the same day instead of counting them as days', () => {
		const today = startOfDayUtc(NOW);
		const shards: CellVolumeDay[] = [];
		for (let day = 1; day <= 3; day += 1) {
			for (let shard = 0; shard < 8; shard += 1) {
				shards.push({ dayStartMs: today - day * DAY, total: 125, own: 125 });
			}
		}
		expect(projectCellVolume(shards, NOW)).toMatchObject({
			dailyVolume: 1000,
			observedDays: 3,
		});
	});

	it('reports the trailing OWN fraction alongside the demand', () => {
		const projection = projectCellVolume(
			trailingDays([1000, 1000, 1000, 1000, 1000, 1000, 1000], [200, 200, 200, 200, 200, 200, 200]),
			NOW
		);
		expect(projection).toMatchObject({ ownDailyVolume: 200, ownFraction: 0.2 });
	});

	it('measures the mix PER DAY, so a jagged week cannot invent a mix no day had', () => {
		// The own arm's big day is not the total's big day. A ratio of two
		// independently-taken statistics would divide the own arm's peak by the
		// total's typical day and report a mix strictly above every day observed;
		// a median over the DAILY ratios can only ever report one of them.
		const totals = [1000, 200, 1000, 200, 1000, 200, 1000];
		const owns = [100, 200, 100, 200, 100, 200, 100];
		const projection = projectCellVolume(trailingDays(totals, owns), NOW);
		if (projection.kind !== 'projected') throw new Error('expected a projection');

		const dailyRatios = totals.map((total, index) => (owns[index] ?? 0) / total);
		expect(projection.ownFraction).toBeLessThanOrEqual(Math.max(...dailyRatios));
		expect(projection.ownFraction).toBeGreaterThanOrEqual(Math.min(...dailyRatios));
		// Four days at 0.1 and three at 1.0: the median day is a tenth.
		expect(projection.ownFraction).toBeCloseTo(0.1, 10);
		// And the own volume stays consistent with the mix it was derived from.
		expect(projection.ownDailyVolume).toBeCloseTo(projection.dailyVolume * 0.1, 10);
	});

	it('a day with no demand contributes no mix rather than a zero one', () => {
		// A paused day is a day with no mix, not a day the own arm carried none of:
		// counting it as 0/0 = 0 would drag the measured mix toward zero and report
		// a shortfall no reroute caused.
		const projection = projectCellVolume(
			trailingDays([1000, 0, 1000, 0, 1000], [800, 0, 800, 0, 800]),
			NOW
		);
		expect(projection).toMatchObject({ ownFraction: 0.8 });
	});

	it('never reports an own arm that carried more than the cell sent', () => {
		const projection = projectCellVolume(
			trailingDays([100, 100, 100, 100, 100, 100, 100], [900, 900, 900, 900, 900, 900, 900]),
			NOW
		);
		expect(projection).toMatchObject({ ownDailyVolume: 100, ownFraction: 1 });
	});
});
