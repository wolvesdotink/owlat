import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { summarize } from '../analytics/sendingReputation';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';

const modules = import.meta.glob('../**/*.*s');

afterEach(() => {
	vi.useRealTimers();
});

describe('MTA remote-acceptance reputation lifecycle', () => {
	it('counts queue acceptance as sent, remote acceptance once as delivered, and never counts a pre-acceptance bounce', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 6, 21, 12));
		const t = convexTest(schema, modules);
		const { acceptedSendId, bouncedSendId } = await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());
			return {
				acceptedSendId: await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ campaignId, contactId, status: 'queued' })
				),
				bouncedSendId: await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ campaignId, contactId, status: 'queued' })
				),
			};
		});

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: acceptedSendId },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'mta-accepted',
				providerType: 'mta',
			},
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		let reputation = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(reputation.totalSent).toBe(1);
		expect(reputation.totalDelivered).toBe(0);

		const accepted = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: 'mta-accepted',
				transition: { to: 'delivered', at: Date.now() },
			}
		);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(accepted.ok && accepted.applied).toBe('transitioned');
		reputation = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(reputation.totalDelivered).toBe(1);

		const duplicate = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: 'mta-accepted',
				transition: { to: 'delivered', at: Date.now() + 1 },
			}
		);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(duplicate.ok && duplicate.applied).toBe('duplicate');
		reputation = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(reputation.totalDelivered).toBe(1);

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: bouncedSendId },
			transition: {
				to: 'sent',
				at: Date.now(),
				providerMessageId: 'mta-bounced-before-acceptance',
				providerType: 'mta',
			},
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await t.mutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, {
			providerMessageId: 'mta-bounced-before-acceptance',
			transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		reputation = await t.run((ctx) => summarize(ctx.db, { kind: 'org' }));
		expect(reputation.totalSent).toBe(2);
		expect(reputation.totalDelivered).toBe(1);
	});
});
