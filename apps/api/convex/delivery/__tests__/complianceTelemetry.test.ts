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
		const observedAt = Date.now();
		for (const primaryDomain of ['alpha.example', 'beta.example']) {
			await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
				providerMessageId: `msg-${primaryDomain}`,
				primaryDomain,
				observedAt,
			});
		}
		await t.mutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
			providerMessageId: 'msg-alpha.example',
			primaryDomain: 'alpha.example',
			observedAt,
		});

		const result = await t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {});
		expect(result.gmail.domains).toEqual([
			{ primaryDomain: 'alpha.example', delivered24h: 1 },
			{ primaryDomain: 'beta.example', delivered24h: 1 },
		]);
		// The member-facing shape never exposes provider message ids/receipts.
		expect(JSON.stringify(result.gmail)).not.toContain('msg-alpha');
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
			spamRate: 0.001,
			spamRateStatus: 'elevated',
		});
		expect(byDomain.get('hard.example')).toMatchObject({
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
