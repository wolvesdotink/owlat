/**
 * The per-minute scheduler tick (`processScheduledCampaigns`) hands every due
 * campaign to the orchestrator as its own scheduled `startCampaignSend`
 * (plan F3.5). It used to await each start inline, one after another, so one
 * slow content scan delayed every campaign behind it and one throw stopped the
 * rest of the tick.
 *
 * The scheduler is held on fake timers: the jobs are inspected, never run.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { createTestCampaign } from '../../__tests__/factories';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe('processScheduledCampaigns', () => {
	it('schedules one start per due campaign and returns without running them', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const { dueA, dueB } = await t.run(async (ctx) => {
			const dueA = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'scheduled', scheduledAt: now - 60_000 })
			);
			const dueB = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'scheduled', scheduledAt: now - 1_000 })
			);
			// Not due yet, and not scheduled at all: neither is picked up.
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'scheduled', scheduledAt: now + 3_600_000 })
			);
			await ctx.db.insert('campaigns', createTestCampaign({ status: 'draft' }));
			return { dueA, dueB };
		});

		const result = await t.action(internal.campaigns.send.processScheduledCampaigns, {});

		expect(result).toEqual({ processedCount: 2 });
		const jobs = await t.run(
			async (ctx) => await ctx.db.system.query('_scheduled_functions').collect()
		);
		const starts = jobs.filter((job) => job.name === 'campaigns/send:startCampaignSend');
		expect(starts.map((job) => job.args[0])).toEqual(
			expect.arrayContaining([{ campaignId: dueA }, { campaignId: dueB }])
		);
		expect(starts).toHaveLength(2);
		// Held, not run inline: both campaigns are still `scheduled`.
		const statuses = await t.run(async (ctx) =>
			[await ctx.db.get(dueA), await ctx.db.get(dueB)].map((c) => c?.status)
		);
		expect(statuses).toEqual(['scheduled', 'scheduled']);
	});
});
