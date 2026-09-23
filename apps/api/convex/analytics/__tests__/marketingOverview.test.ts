/**
 * `analytics.marketingOverview.get` — the Marketing overview's single read.
 *
 * Seeds campaigns straight into the table (their denormalized `stats*`
 * counters are what the query reads) and checks each band's shape: the latest
 * three with a still-sending one flagged, the oldest-first comparison list and
 * its delivered-weighted average, the 30-vs-30-day period totals, the dense
 * opens-per-day series, and the feature gate.
 */
import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { createTestCampaign, createTestTopic, enableFeatures } from '../../__tests__/factories';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'editor' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'editor',
			activeOrganizationId: 'org-1',
		}),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue({
			userId: 'test-user',
			role: 'editor',
			activeOrganizationId: 'org-1',
		}),
	};
});

// Vite canonicalizes glob keys for files in this subtree (see
// campaigns/__tests__/attentionCandidates.test.ts): re-prefix the siblings.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) => {
		if (key.startsWith('../') && !key.startsWith('../../')) {
			return ['../../analytics/' + key.slice(3), val];
		}
		return [key, val];
	})
);

const DAY = 24 * 60 * 60 * 1000;

function sentCampaign(name: string, daysAgo: number, stats: Record<string, number>) {
	return createTestCampaign({
		name,
		status: 'sent',
		sentAt: Date.now() - daysAgo * DAY,
		...stats,
	});
}

describe('analytics.marketingOverview.get', () => {
	it('refuses when the campaigns feature is off', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('instanceSettings', {
				featureFlags: { campaigns: false },
				createdAt: now,
				updatedAt: now,
			});
		});
		await expect(t.query(api.analytics.marketingOverview.get, {})).rejects.toThrow(/campaigns/);
	});

	it('returns empty bands before the first send', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['campaigns']);
		await t.run(async (ctx) => {
			await ctx.db.insert('campaigns', createTestCampaign({ name: 'Draft', status: 'draft' }));
		});

		const overview = await t.query(api.analytics.marketingOverview.get, {});
		expect(overview.latest).toEqual([]);
		expect(overview.recent.campaigns).toEqual([]);
		expect(overview.period.current.delivered).toBe(0);
		expect(overview.period.campaignCount).toBe(0);
		expect(overview.period.weekly).toHaveLength(12);
		expect(overview.opensPerDay).toHaveLength(30);
		expect(overview.delivery.reputation).toBeNull();
	});

	it('builds every band from the denormalized campaign counters', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['campaigns']);
		const today = new Date().toISOString().slice(0, 10);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				sentCampaign('Old', 40, {
					statsSent: 100,
					statsDelivered: 100,
					statsOpened: 20,
					statsClicked: 2,
					statsBounced: 0,
				})
			);
			await ctx.db.insert(
				'campaigns',
				sentCampaign('Middle', 10, {
					statsSent: 100,
					statsDelivered: 100,
					statsOpened: 40,
					statsClicked: 4,
					statsBounced: 0,
				})
			);
			await ctx.db.insert(
				'campaigns',
				sentCampaign('Newest sent', 2, {
					statsSent: 200,
					statsDelivered: 190,
					statsOpened: 95,
					statsClicked: 19,
					statsBounced: 10,
					statsUnsubscribed: 2,
				})
			);
			const topicId = await ctx.db.insert('topics', createTestTopic());
			const sendingId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'In flight',
					status: 'sending',
					sentAt: Date.now() - 60_000,
					statsSent: 30,
					statsDelivered: 25,
				})
			);
			await ctx.db.insert('campaignSendJobs', {
				campaignId: sendingId,
				phase: 'done',
				cursor: '',
				audience: { kind: 'topic', topicId },
				enqueuedCount: 120,
				totalCandidates: 120,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendDailyStats', {
				date: today,
				shardKey: 0,
				sent: 10,
				delivered: 10,
				opened: 4,
				clicked: 1,
			});
			await ctx.db.insert('sendDailyStats', {
				date: today,
				shardKey: 1,
				sent: 10,
				delivered: 10,
				opened: 3,
				clicked: 0,
			});
		});

		const overview = await t.query(api.analytics.marketingOverview.get, {});

		// Band 1: newest first, the sending campaign flagged with live progress.
		expect(overview.latest.map((c) => c.name)).toEqual(['In flight', 'Newest sent', 'Middle']);
		expect(overview.latest[0]!.isSending).toBe(true);
		expect(overview.latest[0]!.progress).toBe(0.25);
		expect(overview.latest[1]!.isSending).toBe(false);
		expect(overview.latest[1]!.unsubscribed).toBe(2);
		expect('progress' in overview.latest[1]!).toBe(false);

		// Comparison list: finished sends only, oldest first.
		expect(overview.recent.campaigns.map((c) => c.name)).toEqual(['Old', 'Middle', 'Newest sent']);
		expect(overview.recent.campaigns[2]!.openRate).toBeCloseTo(0.5, 6);
		expect(overview.recent.average.openRate).toBeCloseTo(155 / 390, 6);

		// Period: the last 30 days hold Middle + Newest sent + the sending one.
		expect(overview.period.campaignCount).toBe(3);
		expect(overview.period.current.delivered).toBe(100 + 190 + 25);
		expect(overview.period.current.bounceRate).toBeCloseTo(10 / 330, 6);
		expect(overview.period.previous.delivered).toBe(100);
		expect(overview.period.weekly).toHaveLength(12);

		// Opens per day: summed across write shards, dense, ending today.
		expect(overview.opensPerDay).toHaveLength(30);
		expect(overview.opensPerDay[29]).toEqual({ date: today, opened: 7 });
	});
});
