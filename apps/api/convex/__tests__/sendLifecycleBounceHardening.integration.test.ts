import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { rollupCampaignStatsRow } from '../campaigns/statShards';
import schema from '../schema';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';

const modules = import.meta.glob('../**/*.*s');
const SOFT_BOUNCE_THRESHOLD = 5;

async function readCampaignWithStats(ctx: MutationCtx, campaignId: Id<'campaigns'>) {
	const campaign = await ctx.db.get(campaignId);
	if (campaign) await rollupCampaignStatsRow(ctx, campaign);
	return ctx.db.get(campaignId);
}

afterEach(async () => {
	// Lifecycle feedback schedules webhook, reputation, and MTA-mirror work.
	// Let convex-test drain those jobs before replacing its global state.
	await new Promise((resolve) => setTimeout(resolve, 25));
});

describe('send lifecycle soft-to-hard bounce reclassification', () => {
	it('keeps one total bounce and upgrades a threshold-created soft suppression in place', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let sendId: Id<'emailSends'>;
		const email = 'threshold-then-hard@example.com';

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ statsBounced: 0, statsHardBounced: 0, statsSoftBounced: 0 })
			);
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email, softBounceCount: SOFT_BOUNCE_THRESHOLD - 1 })
			);
			sendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					contactEmail: email,
				})
			);
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: 1000, bounceType: 'soft' },
		});
		await t.run(async (ctx) => {
			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', email))
				.collect();
			expect(blocked).toHaveLength(1);
			expect(blocked[0]).toMatchObject({
				reason: 'bounced',
				bounceType: 'soft',
				sourceType: 'emailSend',
				sourceEmailSendId: sendId,
			});
		});

		const hardened = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId! },
			transition: { to: 'bounced', at: 2000, bounceType: 'hard' },
		});
		expect(hardened).toMatchObject({ ok: true, applied: 'transitioned' });

		await t.run(async (ctx) => {
			expect(await ctx.db.get(sendId!)).toMatchObject({
				status: 'bounced',
				bounceType: 'hard',
			});
			const blocked = await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', email))
				.collect();
			expect(blocked).toHaveLength(1);
			expect(blocked[0]).toMatchObject({
				reason: 'bounced',
				bounceType: 'hard',
				sourceType: 'emailSend',
				sourceEmailSendId: sendId,
			});

			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.statsBounced).toBe(1);
			expect(campaign?.statsSoftBounced).toBe(0);
			expect(campaign?.statsHardBounced).toBe(1);
		});
	});
});
