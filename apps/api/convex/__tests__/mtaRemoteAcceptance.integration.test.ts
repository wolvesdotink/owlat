import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { summarize } from '../analytics/sendingReputation';
import { readGmailVolumes } from '../delivery/complianceTelemetry';
import { dispatchInboundEvent } from '../webhooks/dispatcher';
import type { InboundEvent } from '../webhooks/types';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';

const modules = import.meta.glob('../**/*.*s');
const NOW = Date.UTC(2026, 6, 21, 12);
const PRIMARY_DOMAIN = 'sender.example';

afterEach(() => {
	vi.useRealTimers();
});

type TestHarness = ReturnType<typeof convexTest>;

function dispatch(t: TestHarness, event: InboundEvent): Promise<void> {
	// The dispatcher is an action-layer function. Keep this integration test on
	// its real mutation references while convex-test supplies the mutation
	// executor; none of these email event handlers use the action scheduler.
	const actionCtx = {
		runMutation: (mutation: Parameters<ActionCtx['runMutation']>[0], args: unknown) =>
			t.mutation(mutation, args),
	} as unknown as ActionCtx;
	return dispatchInboundEvent(actionCtx, event);
}

async function seedSentSend(t: TestHarness, providerMessageId: string): Promise<Id<'emailSends'>> {
	return t.run(async (ctx) => {
		const campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({ fromEmail: `news@${PRIMARY_DOMAIN}` })
		);
		const contactId = await ctx.db.insert('contacts', createTestContact());
		return ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				status: 'sent',
				providerMessageId,
				sentAt: NOW - 1_000,
			})
		);
	});
}

function accepted(providerMessageId: string, at: number): InboundEvent {
	return {
		kind: 'email.delivered',
		providerMessageId,
		at,
		providerType: 'mta',
		destinationProvider: 'gmail',
		primarySendingDomain: PRIMARY_DOMAIN,
	};
}

async function expectExactlyOneDelivery(
	t: TestHarness,
	sendId: Id<'emailSends'>,
	expectedStatus: 'opened' | 'clicked' | 'complained' | 'bounced' | 'failed'
): Promise<void> {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	const [send, reputation, gmailVolume] = await Promise.all([
		t.run((ctx) => ctx.db.get(sendId)),
		t.run((ctx) => summarize(ctx.db, { kind: 'org' })),
		t.run((ctx) => readGmailVolumes(ctx.db)),
	]);
	expect(send).toMatchObject({ status: expectedStatus, deliveredAt: NOW });
	expect(reputation.totalDelivered).toBe(1);
	expect(gmailVolume.domains).toEqual([{ primaryDomain: PRIMARY_DOMAIN, delivered24h: 1 }]);
}

describe('MTA remote-acceptance reputation lifecycle', () => {
	it.each([
		{
			name: 'accepted → opened',
			finalStatus: 'opened' as const,
			events: (messageId: string): InboundEvent[] => [
				accepted(messageId, NOW),
				{ kind: 'email.opened', providerMessageId: messageId, at: NOW + 1 },
			],
		},
		{
			name: 'opened → late accepted',
			finalStatus: 'opened' as const,
			events: (messageId: string): InboundEvent[] => [
				{ kind: 'email.opened', providerMessageId: messageId, at: NOW },
				accepted(messageId, NOW + 1),
			],
		},
		{
			name: 'clicked → late accepted',
			finalStatus: 'clicked' as const,
			events: (messageId: string): InboundEvent[] => [
				{
					kind: 'email.clicked',
					providerMessageId: messageId,
					at: NOW,
					url: 'https://example.com',
				},
				accepted(messageId, NOW + 1),
			],
		},
		{
			name: 'accepted → complained',
			finalStatus: 'complained' as const,
			events: (messageId: string): InboundEvent[] => [
				accepted(messageId, NOW),
				{ kind: 'email.complained', providerMessageId: messageId, at: NOW + 1 },
			],
		},
		{
			name: 'complained → late accepted',
			finalStatus: 'complained' as const,
			events: (messageId: string): InboundEvent[] => [
				{ kind: 'email.complained', providerMessageId: messageId, at: NOW },
				accepted(messageId, NOW + 1),
			],
		},
		{
			name: 'accepted → later bounce',
			finalStatus: 'bounced' as const,
			events: (messageId: string): InboundEvent[] => [
				accepted(messageId, NOW),
				{
					kind: 'email.bounced',
					providerMessageId: messageId,
					at: NOW + 1,
					bounceType: 'hard',
				},
			],
		},
		{
			name: 'later bounce arrives before accepted',
			finalStatus: 'bounced' as const,
			events: (messageId: string): InboundEvent[] => [
				{
					kind: 'email.bounced',
					providerMessageId: messageId,
					at: NOW + 1,
					bounceType: 'hard',
				},
				accepted(messageId, NOW),
			],
		},
		{
			name: 'later failure arrives before accepted',
			finalStatus: 'failed' as const,
			events: (messageId: string): InboundEvent[] => [
				{
					kind: 'email.failed',
					providerMessageId: messageId,
					at: NOW + 1,
					errorMessage: 'ambiguous post-DATA timeout',
					errorCode: 'AMBIGUOUS_TIMEOUT',
				},
				accepted(messageId, NOW),
			],
		},
	])(
		'records delivery once for $name without status regression',
		async ({ finalStatus, events }) => {
			vi.useFakeTimers();
			vi.setSystemTime(NOW);
			const t = convexTest(schema, modules);
			const providerMessageId = `mta-${finalStatus}-${Math.random()}`;
			const sendId = await seedSentSend(t, providerMessageId);

			for (const event of events(providerMessageId)) await dispatch(t, event);
			// Exercise provider retries after the lifecycle has already advanced.
			await dispatch(t, accepted(providerMessageId, NOW + 2));

			await expectExactlyOneDelivery(t, sendId, finalStatus);
		}
	);

	it('does not count or emit Gmail telemetry for a hard bounce before acceptance', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		const providerMessageId = 'mta-preaccept-bounce';
		const sendId = await seedSentSend(t, providerMessageId);

		await dispatch(t, {
			kind: 'email.bounced',
			providerMessageId,
			at: NOW,
			bounceType: 'hard',
		});
		await dispatch(t, accepted(providerMessageId, NOW + 1));
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const [send, reputation, gmailVolume] = await Promise.all([
			t.run((ctx) => ctx.db.get(sendId)),
			t.run((ctx) => summarize(ctx.db, { kind: 'org' })),
			t.run((ctx) => readGmailVolumes(ctx.db)),
		]);
		expect(send).toMatchObject({ status: 'bounced', bounceType: 'hard' });
		expect(send?.deliveredAt).toBeUndefined();
		expect(reputation.totalDelivered).toBe(0);
		expect(gmailVolume.domains).toEqual([]);
	});

	it('does not clear a newer soft-bounce recovery count for replayed earlier acceptance', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		const providerMessageId = 'mta-soft-bounce-before-late-acceptance';
		const sendId = await seedSentSend(t, providerMessageId);

		await dispatch(t, {
			kind: 'email.bounced',
			providerMessageId,
			at: NOW + 1,
			bounceType: 'soft',
		});
		await dispatch(t, accepted(providerMessageId, NOW));

		const { send, contact } = await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			return {
				send,
				contact: send?.contactId ? await ctx.db.get(send.contactId) : null,
			};
		});
		expect(send).toMatchObject({
			status: 'bounced',
			bounceType: 'soft',
			bouncedAt: NOW + 1,
			deliveredAt: NOW,
		});
		expect(contact?.softBounceCount).toBe(1);
	});

	it('clears preexisting soft-bounce history after a failure arrives before acceptance', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		const providerMessageId = 'mta-failure-before-late-acceptance';
		const sendId = await seedSentSend(t, providerMessageId);
		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			if (!send?.contactId) throw new Error('Expected seeded Send to have a contact');
			await ctx.db.patch(send.contactId, { softBounceCount: 2 });
		});

		await dispatch(t, {
			kind: 'email.failed',
			providerMessageId,
			at: NOW + 1,
			errorMessage: 'ambiguous post-DATA timeout',
			errorCode: 'AMBIGUOUS_TIMEOUT',
		});
		await dispatch(t, accepted(providerMessageId, NOW));

		const { send, contact } = await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			return {
				send,
				contact: send?.contactId ? await ctx.db.get(send.contactId) : null,
			};
		});
		expect(send).toMatchObject({ status: 'failed', failedAt: NOW + 1, deliveredAt: NOW });
		expect(contact?.softBounceCount).toBe(0);
	});

	it('does not count or emit Gmail telemetry for a failure before acceptance', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		const providerMessageId = 'mta-preaccept-failure';
		const sendId = await seedSentSend(t, providerMessageId);

		await dispatch(t, {
			kind: 'email.failed',
			providerMessageId,
			at: NOW,
			errorMessage: 'pre-accept failure',
			errorCode: 'MTA_FAILED',
		});
		await dispatch(t, accepted(providerMessageId, NOW + 1));
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const [send, reputation, gmailVolume] = await Promise.all([
			t.run((ctx) => ctx.db.get(sendId)),
			t.run((ctx) => summarize(ctx.db, { kind: 'org' })),
			t.run((ctx) => readGmailVolumes(ctx.db)),
		]);
		expect(send).toMatchObject({ status: 'failed', failedAt: NOW });
		expect(send?.deliveredAt).toBeUndefined();
		expect(reputation.totalDelivered).toBe(0);
		expect(gmailVolume.domains).toEqual([]);
	});

	it('does not recreate delivery or telemetry state after the Send is deleted', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		const providerMessageId = 'mta-deleted-send';
		const sendId = await seedSentSend(t, providerMessageId);
		await t.run((ctx) => ctx.db.delete(sendId));

		await dispatch(t, accepted(providerMessageId, NOW));

		expect(await t.run((ctx) => summarize(ctx.db, { kind: 'org' }))).toMatchObject({
			totalDelivered: 0,
		});
		expect((await t.run((ctx) => readGmailVolumes(ctx.db))).domains).toEqual([]);
	});

	it('fails closed for a malformed terminal Send without an ordering timestamp', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		const providerMessageId = 'mta-malformed-terminal';
		const sendId = await seedSentSend(t, providerMessageId);
		await t.run((ctx) =>
			ctx.db.patch(sendId, { status: 'bounced', bounceType: 'hard', bouncedAt: undefined })
		);

		await dispatch(t, accepted(providerMessageId, NOW));

		const send = await t.run((ctx) => ctx.db.get(sendId));
		expect(send?.deliveredAt).toBeUndefined();
		expect((await t.run((ctx) => readGmailVolumes(ctx.db))).domains).toEqual([]);
	});
});
