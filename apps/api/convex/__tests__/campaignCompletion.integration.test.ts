/**
 * Campaign batch-completion (sending → sent).
 *
 * The per-send workpool callback advances each Send and bumps stats but
 * previously never advanced the CAMPAIGN, so every campaign with ≥1 recipient
 * was stuck in 'sending' forever. These tests pin the completion path:
 *   - the last queued send completing moves the campaign to 'sent';
 *   - a campaign with sends still queued stays 'sending';
 *   - an A/B test stays 'sending' until its winner phase (winner_selected);
 *   - the safety-net cron sweep completes finished campaigns but never an
 *     empty in-flight one (the orchestrator-hasn't-inserted-sends race).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';
import type { Id } from '../_generated/dataModel';
import type { WorkId } from '@convex-dev/workpool';

const modules = import.meta.glob('../**/*.*s');
const testWorkId = 'test-work-id' as WorkId;

function completeArgs(sendId: Id<'emailSends'>) {
	return {
		workId: testWorkId,
		result: {
			kind: 'success' as const,
			returnValue: { success: true, providerMessageId: `msg-${sendId}`, providerType: 'mta' },
		},
		context: { sendRef: { kind: 'campaign' as const, id: sendId } },
	};
}

describe('campaign batch-completion via completeSend', () => {
	it('marks the campaign sent when its only queued send completes', async () => {
		const t = convexTest(schema, modules);
		let campaignId!: Id<'campaigns'>;
		let sendId!: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sending' }));
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert('emailSends', createTestEmailSend({ campaignId, contactId, status: 'queued' }));
		});

		await t.mutation(internal.delivery.sendCompletion.completeSend, completeArgs(sendId));

		await t.run(async (ctx) => {
			expect((await ctx.db.get(sendId))?.status).toBe('sent');
			const campaign = await ctx.db.get(campaignId);
			expect(campaign?.status).toBe('sent');
		});
	});

	it('stays sending while other sends are still queued; completes on the last', async () => {
		const t = convexTest(schema, modules);
		let campaignId!: Id<'campaigns'>;
		let sendA!: Id<'emailSends'>;
		let sendB!: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sending' }));
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendA = await ctx.db.insert('emailSends', createTestEmailSend({ campaignId, contactId, status: 'queued' }));
			sendB = await ctx.db.insert('emailSends', createTestEmailSend({ campaignId, contactId, status: 'queued' }));
		});

		await t.mutation(internal.delivery.sendCompletion.completeSend, completeArgs(sendA));
		await t.run(async (ctx) => {
			expect((await ctx.db.get(campaignId))?.status).toBe('sending'); // sendB still queued
		});

		await t.mutation(internal.delivery.sendCompletion.completeSend, completeArgs(sendB));
		await t.run(async (ctx) => {
			expect((await ctx.db.get(campaignId))?.status).toBe('sent');
		});
	});

	it('A/B test stays sending until winner_selected', async () => {
		const t = convexTest(schema, modules);
		let campaignId!: Id<'campaigns'>;
		let sendId!: Id<'emailSends'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending', isABTest: true, abTestStatus: 'testing' }),
			);
			const contactId = await ctx.db.insert('contacts', createTestContact());
			sendId = await ctx.db.insert('emailSends', createTestEmailSend({ campaignId, contactId, status: 'queued' }));
		});

		// Test phase completes — but the winner-to-remainder phase is still pending.
		await t.mutation(internal.delivery.sendCompletion.completeSend, completeArgs(sendId));
		await t.run(async (ctx) => {
			expect((await ctx.db.get(campaignId))?.status).toBe('sending');
		});

		// Winner selected + remainder send queued and completed → now sent.
		let remainder!: Id<'emailSends'>;
		await t.run(async (ctx) => {
			await ctx.db.patch(campaignId, { abTestStatus: 'winner_selected' });
			const contactId = await ctx.db.insert('contacts', createTestContact());
			remainder = await ctx.db.insert('emailSends', createTestEmailSend({ campaignId, contactId, status: 'queued' }));
		});
		await t.mutation(internal.delivery.sendCompletion.completeSend, completeArgs(remainder));
		await t.run(async (ctx) => {
			expect((await ctx.db.get(campaignId))?.status).toBe('sent');
		});
	});
});

describe('reconcileSendingCampaigns (safety-net cron)', () => {
	it('completes a finished campaign but skips an empty in-flight one', async () => {
		const t = convexTest(schema, modules);
		let finished!: Id<'campaigns'>;
		let empty!: Id<'campaigns'>;
		await t.run(async (ctx) => {
			// finished: 'sending' with a terminal send and nothing queued.
			finished = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sending' }));
			const c1 = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('emailSends', createTestEmailSend({ campaignId: finished, contactId: c1, status: 'sent' }));
			// empty: 'sending' with NO sends yet (orchestrator hasn't inserted them).
			empty = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sending' }));
		});

		const result = await t.mutation(internal.campaigns.lifecycle.reconcileSendingCampaigns, {});
		expect(result.checked).toBe(2);
		expect(result.completed).toBe(1);

		await t.run(async (ctx) => {
			expect((await ctx.db.get(finished))?.status).toBe('sent');
			expect((await ctx.db.get(empty))?.status).toBe('sending'); // race guard: not completed
		});
	});
});
