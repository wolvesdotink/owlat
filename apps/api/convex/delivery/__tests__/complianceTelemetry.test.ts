import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { refreshPendingGmailVolumes } from '../../__tests__/helpers/gmailVolume';
import {
	COMPLIANCE_CLEANUP_BATCH_SIZE,
	GMAIL_ACCEPTED_AT_FUTURE_SKEW_MS,
	GMAIL_DASHBOARD_DOMAIN_LIMIT,
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

afterEach(() => {
	vi.useRealTimers();
});

describe('Gmail bulk-sender volume', () => {
	it('is idempotent by provider message id and keeps primary domains isolated', async () => {
		const t = convexTest(schema, modules);
		const acceptedAt = Date.now();
		for (const [providerMessageId, primaryDomain] of [
			['msg-alpha-1', 'alpha.example'],
			['msg-alpha-2', 'alpha.example'],
			['msg-beta', 'beta.example'],
		] as const) {
			await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
				providerMessageId,
				primaryDomain,
				acceptedAt,
			});
		}
		await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
			providerMessageId: 'msg-alpha-1',
			primaryDomain: 'alpha.example',
			acceptedAt,
		});
		await refreshPendingGmailVolumes(t);

		const result = await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {});
		expect(result.gmail.domains).toEqual([
			{ primaryDomain: 'alpha.example', delivered24h: 2 },
			{ primaryDomain: 'beta.example', delivered24h: 1 },
		]);
		// The member-facing shape never exposes provider message ids/receipts.
		expect(JSON.stringify(result.gmail)).not.toContain('msg-alpha');
	});

	it('caps the indexed domain read while retaining exact top-domain totals', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const currentHour = Math.floor(now / 3_600_000) * 3_600_000;
		await t.run(async (ctx) => {
			for (let index = 0; index < GMAIL_DASHBOARD_DOMAIN_LIMIT + 5; index++) {
				const deliveredCount = index + 1;
				await ctx.db.insert('gmailDomainVolumeRollups', {
					primaryDomain: `domain-${String(index).padStart(3, '0')}.example`,
					hourlyCounts: [{ hourStart: currentHour, deliveredCount }],
					deliveredCount,
					windowRefreshedAt: now,
				});
			}
		});

		const result = await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {});
		expect(result.gmail.domains).toHaveLength(GMAIL_DASHBOARD_DOMAIN_LIMIT);
		expect(result.gmail.domainLimit).toBe(GMAIL_DASHBOARD_DOMAIN_LIMIT);
		expect(result.gmail.isDomainListTruncated).toBe(true);
		expect(result.gmail.domains[0]).toEqual({
			primaryDomain: 'domain-104.example',
			delivered24h: 105,
		});
		expect(result.gmail.domains[result.gmail.domains.length - 1]?.delivered24h).toBe(6);
	});

	it('shards a concurrent high-volume burst and coalesces one asynchronous rollup', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 6, 21, 12, 30));
		const t = convexTest(schema, modules);
		const primaryDomain = 'burst.example';
		const deliveredCount = 256;
		await Promise.all(
			Array.from({ length: deliveredCount }, (_, index) =>
				t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
					providerMessageId: `burst-${index}`,
					primaryDomain,
					acceptedAt: Date.now(),
				})
			)
		);

		await t.run(async (ctx) => {
			const buckets = await ctx.db
				.query('gmailVolumeBuckets')
				.withIndex('by_domain_hour_shard', (q) => q.eq('primaryDomain', primaryDomain))
				.take(16);
			expect(buckets).toHaveLength(8);
			expect(buckets.reduce((sum, bucket) => sum + bucket.deliveredCount, 0)).toBe(deliveredCount);
			expect(
				await ctx.db
					.query('gmailDomainVolumeRollupJobs')
					.withIndex('by_domain', (q) => q.eq('primaryDomain', primaryDomain))
					.take(2)
			).toHaveLength(1);
			expect(
				await ctx.db
					.query('gmailDomainVolumeRollups')
					.withIndex('by_domain', (q) => q.eq('primaryDomain', primaryDomain))
					.unique()
			).toBeNull();
		});

		await refreshPendingGmailVolumes(t);
		expect(
			(await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {})).gmail.domains
		).toContainEqual({ primaryDomain, delivered24h: deliveredCount });
	});

	it('uses accepted event time for the 24-hour window and ingest time for retention', async () => {
		vi.useFakeTimers();
		const now = Date.UTC(2026, 6, 21, 12, 30);
		vi.setSystemTime(now);
		try {
			const t = convexTest(schema, modules);
			for (const [providerMessageId, primaryDomain, acceptedAt] of [
				['current', 'current.example', now],
				['inside-window', 'inside.example', now - 23 * 3_600_000],
				['delayed-30h', 'delayed.example', now - 30 * 3_600_000],
			] as const) {
				await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
					providerMessageId,
					primaryDomain,
					acceptedAt,
				});
			}
			await refreshPendingGmailVolumes(t);
			await t.run(async (ctx) => {
				const receipt = await ctx.db
					.query('gmailDeliveryReceipts')
					.withIndex('by_message_id', (q) => q.eq('providerMessageId', 'delayed-30h'))
					.unique();
				expect(receipt).toMatchObject({
					acceptedAt: now - 30 * 3_600_000,
					ingestedAt: now,
				});
			});

			const result = await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {});
			expect(result.gmail.domains).toEqual([
				{ primaryDomain: 'current.example', delivered24h: 1 },
				{ primaryDomain: 'inside.example', delivered24h: 1 },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not move a delayed delivery into the current window after receipt expiry and replay', async () => {
		vi.useFakeTimers();
		const firstIngestAt = Date.UTC(2026, 6, 21, 12, 30);
		const acceptedAt = firstIngestAt - 30 * 3_600_000;
		vi.setSystemTime(firstIngestAt);
		try {
			const t = convexTest(schema, modules);
			await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
				providerMessageId: 'delayed-replay',
				primaryDomain: 'delayed.example',
				acceptedAt,
			});
			expect(
				(await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {})).gmail.domains
			).toEqual([]);

			vi.setSystemTime(firstIngestAt + 49 * 3_600_000);
			await t.mutation(internal.delivery.complianceTelemetry.cleanupComplianceTelemetry, {});
			const replay = await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
				providerMessageId: 'delayed-replay',
				primaryDomain: 'delayed.example',
				acceptedAt,
			});
			expect(replay).toEqual({ recorded: false, reason: 'stale_accepted_at' });
			expect(
				(await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {})).gmail.domains
			).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('clamps bounded future skew, rejects larger skew, and cleans poisoned rows', async () => {
		vi.useFakeTimers();
		const now = Date.UTC(2026, 6, 21, 12, 30);
		vi.setSystemTime(now);
		try {
			const t = convexTest(schema, modules);
			const boundary = await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
				providerMessageId: 'future-boundary',
				primaryDomain: 'boundary.example',
				acceptedAt: now + GMAIL_ACCEPTED_AT_FUTURE_SKEW_MS,
			});
			expect(boundary).toEqual({ recorded: true });
			await refreshPendingGmailVolumes(t);
			const tooFar = await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
				providerMessageId: 'future-rejected',
				primaryDomain: 'future.example',
				acceptedAt: now + GMAIL_ACCEPTED_AT_FUTURE_SKEW_MS + 1,
			});
			expect(tooFar).toEqual({ recorded: false, reason: 'future_accepted_at' });
			expect(
				(await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {})).gmail.domains
			).toEqual([{ primaryDomain: 'boundary.example', delivered24h: 1 }]);

			await t.run(async (ctx) => {
				await ctx.db.insert('gmailDeliveryReceipts', {
					providerMessageId: 'legacy-current',
					observedAt: now,
				});
				await ctx.db.insert('gmailDeliveryReceipts', {
					providerMessageId: 'future-ingest-poison',
					ingestedAt: now + 24 * 3_600_000,
				});
				await ctx.db.insert('gmailDeliveryReceipts', {
					providerMessageId: 'legacy-future-poison',
					observedAt: now + 24 * 3_600_000,
				});
				await ctx.db.insert('gmailVolumeBuckets', {
					primaryDomain: 'future-bucket.example',
					hourStart: now + 24 * 3_600_000,
					shardKey: 0,
					deliveredCount: 99,
				});
			});
			await t.mutation(internal.delivery.complianceTelemetry.cleanupComplianceTelemetry, {});
			await t.run(async (ctx) => {
				for (const providerMessageId of ['future-ingest-poison', 'legacy-future-poison']) {
					expect(
						await ctx.db
							.query('gmailDeliveryReceipts')
							.withIndex('by_message_id', (q) => q.eq('providerMessageId', providerMessageId))
							.unique()
					).toBeNull();
				}
				for (const providerMessageId of ['future-boundary', 'legacy-current']) {
					expect(
						await ctx.db
							.query('gmailDeliveryReceipts')
							.withIndex('by_message_id', (q) => q.eq('providerMessageId', providerMessageId))
							.unique()
					).not.toBeNull();
				}
				expect(
					await ctx.db
						.query('gmailVolumeBuckets')
						.withIndex('by_domain_hour_shard', (q) =>
							q.eq('primaryDomain', 'future-bucket.example')
						)
						.collect()
				).toEqual([]);
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('drains new, legacy, bucket, and rollup retention backlogs across batches', async () => {
		vi.useFakeTimers();
		const now = Date.UTC(2026, 6, 21, 12, 30);
		vi.setSystemTime(now);
		const t = convexTest(schema, modules);
		const rowCount = COMPLIANCE_CLEANUP_BATCH_SIZE + 5;
		await t.run(async (ctx) => {
			for (let index = 0; index < rowCount; index++) {
				await ctx.db.insert('gmailDeliveryReceipts', {
					providerMessageId: `expired-new-${index}`,
					ingestedAt: now - 72 * 3_600_000,
				});
				await ctx.db.insert('gmailDeliveryReceipts', {
					providerMessageId: `expired-legacy-${index}`,
					observedAt: now - 72 * 3_600_000,
				});
				await ctx.db.insert('gmailVolumeBuckets', {
					primaryDomain: `legacy-${index}.example`,
					hourStart: now - 72 * 3_600_000,
					shardKey: 0,
					deliveredCount: 1,
				});
				await ctx.db.insert('gmailDomainVolumeRollups', {
					primaryDomain: `expired-${index}.example`,
					hourlyCounts: [{ hourStart: now - 72 * 3_600_000, deliveredCount: 1 }],
					deliveredCount: 1,
					windowRefreshedAt: now - 3_600_000,
				});
				await ctx.db.insert('gmailDomainVolumeRollupJobs', {
					primaryDomain: `legacy-${index}.example`,
					scheduledAt: now - 3_600_000,
				});
			}
		});

		const firstBatch = await t.mutation(
			internal.delivery.complianceTelemetry.cleanupComplianceTelemetry,
			{}
		);
		expect(firstBatch.continuationScheduled).toBe(true);
		await t.run(async (ctx) => {
			expect(
				await ctx.db
					.query('gmailDeliveryReceipts')
					.withIndex('by_ingested_at', (q) => q.gt('ingestedAt', 0))
					.take(rowCount)
			).toHaveLength(5);
			expect(
				await ctx.db
					.query('gmailDeliveryReceipts')
					.withIndex('by_observed_at', (q) => q.gt('observedAt', 0))
					.take(rowCount)
			).toHaveLength(5);
		});

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('gmailDeliveryReceipts').take(1)).toEqual([]);
			expect(await ctx.db.query('gmailVolumeBuckets').take(1)).toEqual([]);
			expect(await ctx.db.query('gmailDomainVolumeRollups').take(1)).toEqual([]);
			expect(await ctx.db.query('gmailDomainVolumeRollupJobs').take(1)).toEqual([]);
		});
	});

	it('fires the seeded approaching-5k warning and rejects anonymous reads', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('gmailDomainVolumeRollups', {
				primaryDomain: 'demo.example',
				hourlyCounts: [
					{
						hourStart: Math.floor(Date.now() / 3_600_000) * 3_600_000,
						deliveredCount: 4_500,
					},
				],
				deliveredCount: 4_500,
				windowRefreshedAt: Date.now(),
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
