import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { deriveSnapshot, startOfDayUtc } from '../reputationSnapshots';
import type { ReputationSummary } from '../sendingReputation';

/**
 * The daily reputation-snapshot cron (analytics/reputationSnapshots.ts): the
 * pure derivation, plus write idempotency and >90-day pruning through convex-test.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Vite's `import.meta.glob` excludes the directory chain it climbed to reach the
// glob base, so `'../../**'` from this `analytics/__tests__` file omits the
// sibling `analytics/*` modules (including `reputationSnapshots.ts`, the unit
// under test). Merge a second glob rooted at `analytics/` and re-prefix its keys
// to the same `../../`-relative form so convex-test resolves every entry.
const rootGlob = import.meta.glob('../../**/*.*s');
const analyticsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../analytics/'),
		mod,
	])
);
const modules = { ...rootGlob, ...analyticsGlob };

const ZERO: ReputationSummary = {
	totalSent: 0,
	totalDelivered: 0,
	totalBounced: 0,
	totalHardBounced: 0,
	totalComplaints: 0,
	bounceRate: 0,
	complaintRate: 0,
	riskLevel: 'low',
};

describe('deriveSnapshot', () => {
	it('projects delivery rate as delivered / sent', () => {
		const summary: ReputationSummary = {
			...ZERO,
			totalSent: 1000,
			totalDelivered: 950,
			totalBounced: 30,
			totalComplaints: 2,
			bounceRate: 0.03,
			complaintRate: 0.002,
			riskLevel: 'medium',
		};
		expect(deriveSnapshot(summary)).toEqual({
			deliveryRate: 0.95,
			bounceRate: 0.03,
			complaintRate: 0.002,
			sentCount: 1000,
		});
	});

	it('guards a zero-send window against divide-by-zero (rate 0, not NaN)', () => {
		const snap = deriveSnapshot(ZERO);
		expect(snap.deliveryRate).toBe(0);
		expect(snap.sentCount).toBe(0);
	});
});

/** Seed one org-scope reputation bucket for today so `summarize` has data. */
async function seedOrgBucket(
	t: ReturnType<typeof convexTest>,
	counters: { sent: number; delivered: number; bounced: number; complaints: number }
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('sendingReputation', {
			scope: 'org',
			periodStart: startOfDayUtc(Date.now()),
			shardKey: 0,
			totalSent: counters.sent,
			totalDelivered: counters.delivered,
			totalBounced: counters.bounced,
			totalHardBounced: 0,
			totalComplaints: counters.complaints,
			lastCalculatedAt: Date.now(),
		});
	});
}

describe('writeDailySnapshot', () => {
	it('writes one snapshot row derived from the rolling org reputation', async () => {
		const t = convexTest(schema, modules);
		await seedOrgBucket(t, { sent: 1000, delivered: 950, bounced: 30, complaints: 2 });

		await t.mutation(internal.analytics.reputationSnapshots.writeDailySnapshot, {});

		const rows = await t.run((ctx) => ctx.db.query('deliverySnapshots').collect());
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.periodStart).toBe(startOfDayUtc(Date.now()));
		expect(row.deliveryRate).toBeCloseTo(0.95, 5);
		expect(row.bounceRate).toBeCloseTo(0.03, 5);
		expect(row.complaintRate).toBeCloseTo(0.002, 5);
		expect(row.sentCount).toBe(1000);
	});

	it('is idempotent per day — a second run patches, not duplicates', async () => {
		const t = convexTest(schema, modules);
		await seedOrgBucket(t, { sent: 500, delivered: 480, bounced: 15, complaints: 1 });

		await t.mutation(internal.analytics.reputationSnapshots.writeDailySnapshot, {});
		await t.mutation(internal.analytics.reputationSnapshots.writeDailySnapshot, {});

		const rows = await t.run((ctx) => ctx.db.query('deliverySnapshots').collect());
		expect(rows).toHaveLength(1);
	});

	it('prunes snapshot points older than the ~90-day retention horizon', async () => {
		const t = convexTest(schema, modules);
		await seedOrgBucket(t, { sent: 100, delivered: 100, bounced: 0, complaints: 0 });

		// A stale point ~100 days old, plus a recent one that must survive.
		const stalePeriod = startOfDayUtc(Date.now() - 100 * DAY_MS);
		const recentPeriod = startOfDayUtc(Date.now() - 5 * DAY_MS);
		await t.run(async (ctx) => {
			for (const periodStart of [stalePeriod, recentPeriod]) {
				await ctx.db.insert('deliverySnapshots', {
					periodStart,
					deliveryRate: 1,
					bounceRate: 0,
					complaintRate: 0,
					sentCount: 0,
					createdAt: periodStart,
				});
			}
		});

		await t.mutation(internal.analytics.reputationSnapshots.writeDailySnapshot, {});

		const periods = await t.run((ctx) =>
			ctx.db
				.query('deliverySnapshots')
				.collect()
				.then((rows) => rows.map((r) => r.periodStart))
		);
		expect(periods).not.toContain(stalePeriod);
		expect(periods).toContain(recentPeriod);
		expect(periods).toContain(startOfDayUtc(Date.now()));
	});
});
