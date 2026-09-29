import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { bumpSendDailyStat, readDailyStats } from '../sendDailyStats';
import { denseDailyOpens } from '../../analytics/marketingOverviewMath';
import { utcDayKey } from '../clock';

const modules = import.meta.glob('../../**/*.*s');

describe('sharded sendDailyStats', () => {
	it('spreads writes across shards and sums them on read', async () => {
		const t = convexTest(schema, modules);
		const at = Date.UTC(2026, 5, 4, 12, 0, 0);

		await t.run(async (ctx) => {
			for (let i = 0; i < 50; i++) await bumpSendDailyStat(ctx, 'sent', at);
			for (let i = 0; i < 20; i++) await bumpSendDailyStat(ctx, 'delivered', at);
			for (let i = 0; i < 10; i++) await bumpSendDailyStat(ctx, 'opened', at);
		});

		await t.run(async (ctx) => {
			const daily = await readDailyStats(ctx.db, 30, at + 1000);
			const total = daily.reduce(
				(acc, r) => ({
					sent: acc.sent + r.sent,
					delivered: acc.delivered + r.delivered,
					opened: acc.opened + r.opened,
					clicked: acc.clicked + r.clicked,
				}),
				{ sent: 0, delivered: 0, opened: 0, clicked: 0 }
			);
			expect(total.sent).toBe(50);
			expect(total.delivered).toBe(20);
			expect(total.opened).toBe(10);
			expect(total.clicked).toBe(0);

			// The 80 events spread across multiple shard rows (≤ SHARD_COUNT),
			// instead of contending on a single today-row.
			const rows = await ctx.db.query('sendDailyStats').collect();
			expect(rows.length).toBeGreaterThan(1);
			expect(rows.length).toBeLessThanOrEqual(16);
		});
	});

	it('excludes days outside the window', async () => {
		const t = convexTest(schema, modules);
		const recent = Date.UTC(2026, 5, 4, 12);
		const old = recent - 40 * 24 * 60 * 60 * 1000; // 40 days earlier

		await t.run(async (ctx) => {
			await bumpSendDailyStat(ctx, 'sent', recent);
			await bumpSendDailyStat(ctx, 'sent', old);
		});

		await t.run(async (ctx) => {
			const daily = await readDailyStats(ctx.db, 30, recent + 1000);
			const total = daily.reduce((acc, r) => acc + r.sent, 0);
			expect(total).toBe(1); // only the in-window day counts
		});
	});

	it('spans exactly `days` calendar days (30-day boundary, not 31)', async () => {
		const t = convexTest(schema, modules);
		const DAY = 24 * 60 * 60 * 1000;
		const now = Date.UTC(2026, 5, 4, 12);

		await t.run(async (ctx) => {
			await bumpSendDailyStat(ctx, 'sent', now); // today (day 0)
			await bumpSendDailyStat(ctx, 'sent', now - 29 * DAY); // oldest still in window
			await bumpSendDailyStat(ctx, 'sent', now - 30 * DAY); // just outside the 30-day window
		});

		await t.run(async (ctx) => {
			const daily = await readDailyStats(ctx.db, 30, now + 1000);
			expect(daily.length).toBe(2); // day 0 + day-29; day-30 excluded
			expect(daily.reduce((acc, r) => acc + r.sent, 0)).toBe(2);
		});
	});

	it('writes rows under the key the marketing overview reads them back by', async () => {
		const t = convexTest(schema, modules);
		const midnight = Date.UTC(2026, 8, 3);
		// Either side of midnight UTC: the boundary where a writer and a reader
		// spelling the day differently would put an event on the wrong bar.
		const lastMsOfDay = midnight - 1;
		const firstMsOfNextDay = midnight;

		await t.run(async (ctx) => {
			await bumpSendDailyStat(ctx, 'opened', lastMsOfDay);
			await bumpSendDailyStat(ctx, 'opened', firstMsOfNextDay);
			await bumpSendDailyStat(ctx, 'opened', firstMsOfNextDay);
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('sendDailyStats').collect();
			expect(new Set(rows.map((r) => r.date))).toEqual(
				new Set([utcDayKey(lastMsOfDay), utcDayKey(firstMsOfNextDay)])
			);

			const now = firstMsOfNextDay + 60_000;
			const series = denseDailyOpens(await readDailyStats(ctx.db, 2, now), 2, now);
			expect(series).toEqual([
				{ date: '2026-09-02', opened: 1 },
				{ date: '2026-09-03', opened: 2 },
			]);
		});
	});
});
