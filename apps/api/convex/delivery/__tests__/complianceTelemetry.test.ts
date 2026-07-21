import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import {
	histogramPercentileUpperBound,
	latencyBucketIndex,
	UNSUBSCRIBE_HONOR_WINDOW_MS,
} from '../complianceTelemetry';

let authenticated = true;
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getUserIdFromSession: vi.fn(async () => {
			if (!authenticated) throw new Error('Not authenticated');
			return 'user-1';
		}),
		requireOrgMember: vi.fn(async () => {
			if (!authenticated) throw new Error('Not authenticated');
			return { userId: 'user-1', role: 'member' };
		}),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const analyticsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../../analytics/**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\/\.\.\//, '../../'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob, ...analyticsGlob };

beforeEach(() => {
	authenticated = true;
});

describe('Gmail bulk-sender volume', () => {
	it('is idempotent by provider message id and keeps primary domains isolated', async () => {
		const t = convexTest(schema, modules);
		for (const primaryDomain of ['alpha.example', 'beta.example']) {
			await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
				providerMessageId: `msg-${primaryDomain}`,
				primaryDomain,
			});
		}
		await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
			providerMessageId: 'msg-alpha.example',
			primaryDomain: 'alpha.example',
		});

		const result = await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {});
		expect(result.gmail.domains).toEqual([
			{ primaryDomain: 'alpha.example', delivered24h: 1 },
			{ primaryDomain: 'beta.example', delivered24h: 1 },
		]);
		// The member-facing shape never exposes provider message ids/receipts.
		expect(JSON.stringify(result.gmail)).not.toContain('msg-alpha');
	});

	it('uses trusted ingest time, excludes stale/future buckets, and cleans poisoned rows', async () => {
		vi.useFakeTimers();
		const now = Date.UTC(2026, 6, 21, 12, 30);
		vi.setSystemTime(now);
		try {
			const t = convexTest(schema, modules);
			await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
				providerMessageId: 'trusted-now',
				primaryDomain: 'trusted.example',
			});
			await t.run(async (ctx) => {
				const receipt = await ctx.db
					.query('gmailDeliveryReceipts')
					.withIndex('by_message_id', (q) => q.eq('providerMessageId', 'trusted-now'))
					.unique();
				expect(receipt?.observedAt).toBe(now);

				for (const [primaryDomain, hourStart] of [
					['inside.example', now - 23 * 3_600_000],
					['stale.example', now - 26 * 3_600_000],
					['future.example', now + 24 * 3_600_000],
				] as const) {
					await ctx.db.insert('gmailVolumeBuckets', {
						primaryDomain,
						hourStart: Math.floor(hourStart / 3_600_000) * 3_600_000,
						shardKey: 0,
						deliveredCount: 99,
					});
				}
				await ctx.db.insert('gmailDeliveryReceipts', {
					providerMessageId: 'future-receipt',
					observedAt: now + 24 * 3_600_000,
				});
			});

			const result = await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {});
			expect(result.gmail.domains).toEqual([
				{ primaryDomain: 'inside.example', delivered24h: 99 },
				{ primaryDomain: 'trusted.example', delivered24h: 1 },
			]);

			await t.mutation(internal.delivery.complianceTelemetry.cleanupComplianceTelemetry, {});
			await t.run(async (ctx) => {
				expect(
					await ctx.db
						.query('gmailDeliveryReceipts')
						.withIndex('by_message_id', (q) => q.eq('providerMessageId', 'future-receipt'))
						.unique()
				).toBeNull();
				const futureBuckets = await ctx.db
					.query('gmailVolumeBuckets')
					.withIndex('by_hour', (q) => q.gt('hourStart', now))
					.collect();
				expect(futureBuckets).toHaveLength(0);
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('fires the seeded approaching-5k warning and rejects anonymous reads', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('gmailVolumeBuckets', {
				primaryDomain: 'demo.example',
				hourStart: Math.floor(Date.now() / 3_600_000) * 3_600_000,
				shardKey: 0,
				deliveredCount: 4_500,
			});
		});
		const result = await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {});
		expect(result.gmail.approachingBulkClassification).toBe(true);
		expect(result.gmail.highestVolumeDomain).toMatchObject({
			primaryDomain: 'demo.example',
			delivered24h: 4_500,
		});

		authenticated = false;
		await expect(
			t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {})
		).rejects.toThrow('Not authenticated');
	});
});

describe('per-domain delivery dashboard spam rates', () => {
	it('shows each sending domain against the target and hard boundaries', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		await t.run(async (ctx) => {
			for (const [domain, complaints] of [
				['target.example', 1],
				['hard.example', 3],
			] as const) {
				await ctx.db.insert('domains', {
					domain,
					status: 'verified',
					dnsRecords: {},
					createdAt: now,
					updatedAt: now,
				});
				await ctx.db.insert('sendingReputation', {
					scope: 'domain',
					domain,
					periodStart: new Date(now).setUTCHours(0, 0, 0, 0),
					shardKey: 0,
					totalSent: 1_000,
					totalDelivered: 1_000,
					totalBounced: 0,
					totalHardBounced: 0,
					totalComplaints: complaints,
					lastCalculatedAt: now,
				});
			}
		});

		const rows = await t.query(api.analytics.reputationQueries.getDeliveryDomainTable, {});
		const byDomain = new Map(rows.map((row) => [row.domain, row]));
		expect(byDomain.get('target.example')).toMatchObject({
			sent30d: 1_000,
			delivered30d: 1_000,
			complaints30d: 1,
			spamRate: 0.001,
			spamRateStatus: 'elevated',
		});
		expect(byDomain.get('hard.example')).toMatchObject({
			sent30d: 1_000,
			delivered30d: 1_000,
			complaints30d: 3,
			spamRate: 0.003,
			spamRateStatus: 'hard_limit',
		});
	});
});

describe('unsubscribe processing latency histogram', () => {
	it('computes p95 across bucket boundaries and alerts only beyond 48 hours', () => {
		const counts = Array(11).fill(0) as number[];
		counts[latencyBucketIndex(250)] = 95;
		counts[latencyBucketIndex(UNSUBSCRIBE_HONOR_WINDOW_MS + 1)] = 5;
		expect(histogramPercentileUpperBound(counts, 0.95)).toBe(250);
		counts[latencyBucketIndex(UNSUBSCRIBE_HONOR_WINDOW_MS + 1)] = 6;
		expect(histogramPercentileUpperBound(counts, 0.95)).toBeGreaterThan(
			UNSUBSCRIBE_HONOR_WINDOW_MS
		);
	});
});
