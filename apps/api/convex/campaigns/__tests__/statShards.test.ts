import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { bumpCampaignStats, summarizeCampaignStats, rollupCampaignStatsRow } from '../statShards';
import { createTestCampaign } from '../../__tests__/factories';
import { CAMPAIGN_SHARDED_STAT_FIELDS } from '../../lib/validators/campaigns';

const modules = import.meta.glob('../../**/*.*s');

describe('campaign stat shards', () => {
	it('spreads bumps across shards, sums them, and rolls into campaigns.stats*', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await t.run(async (ctx) =>
			ctx.db.insert('campaigns', createTestCampaign({ statsSent: 0, statsDelivered: 0 }))
		);

		await t.run(async (ctx) => {
			for (let i = 0; i < 50; i++) await bumpCampaignStats(ctx, campaignId, { statsSent: 1 });
			for (let i = 0; i < 20; i++) await bumpCampaignStats(ctx, campaignId, { statsDelivered: 1 });
			// two-field bump (the bounced case)
			for (let i = 0; i < 5; i++)
				await bumpCampaignStats(ctx, campaignId, { statsBounced: 1, statsHardBounced: 1 });
		});

		await t.run(async (ctx) => {
			const sum = await summarizeCampaignStats(ctx.db, campaignId);
			expect(sum.statsSent).toBe(50);
			expect(sum.statsDelivered).toBe(20);
			expect(sum.statsBounced).toBe(5);
			expect(sum.statsHardBounced).toBe(5);
			expect(sum.statsClicked).toBe(0);

			// The 75 events spread across multiple shard rows (≤ SHARD_COUNT).
			const shards = await ctx.db.query('campaignStatShards').collect();
			expect(shards.length).toBeGreaterThan(1);
			expect(shards.length).toBeLessThanOrEqual(8);
		});

		// The campaigns row stays untouched until the rollup runs…
		expect((await t.run(async (ctx) => ctx.db.get(campaignId)))?.statsSent).toBe(0);

		// …then the rollup writes the summed values into campaigns.stats*.
		await t.run(async (ctx) => {
			const c = await ctx.db.get(campaignId);
			if (c) await rollupCampaignStatsRow(ctx, c);
		});
		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.statsSent).toBe(50);
		expect(campaign?.statsDelivered).toBe(20);
		expect(campaign?.statsBounced).toBe(5);
		expect(campaign?.statsHardBounced).toBe(5);
	});

	it('every sharded counter is a column on both campaigns and campaignStatShards', () => {
		const campaignColumns = Object.keys(schema.tables.campaigns.validator.fields);
		const shardColumns = Object.keys(schema.tables.campaignStatShards.validator.fields);
		for (const field of CAMPAIGN_SHARDED_STAT_FIELDS) {
			expect(campaignColumns).toContain(field);
			expect(shardColumns).toContain(field);
		}
		// The shard row holds nothing but its key and the sharded counters.
		expect(new Set(shardColumns)).toEqual(
			new Set(['campaignId', 'shardKey', ...CAMPAIGN_SHARDED_STAT_FIELDS])
		);
		// statsUnsubscribed is a direct counter on the campaign, never sharded.
		expect(campaignColumns).toContain('statsUnsubscribed');
		expect(shardColumns).not.toContain('statsUnsubscribed');
	});

	it('the rollup carries every sharded counter onto the campaign', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await t.run(async (ctx) =>
			ctx.db.insert('campaigns', createTestCampaign({}))
		);
		const expected = Object.fromEntries(
			CAMPAIGN_SHARDED_STAT_FIELDS.map((field, index) => [field, index + 1])
		);
		await t.run(async (ctx) => {
			await bumpCampaignStats(ctx, campaignId, expected);
			const c = await ctx.db.get(campaignId);
			if (c) await rollupCampaignStatsRow(ctx, c);
		});
		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		for (const field of CAMPAIGN_SHARDED_STAT_FIELDS) {
			expect(campaign?.[field]).toBe(expected[field]);
		}
	});
});
