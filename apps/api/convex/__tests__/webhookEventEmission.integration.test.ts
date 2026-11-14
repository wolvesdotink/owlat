import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestTransactionalEmail,
} from './factories';
import type { Id } from '../_generated/dataModel';
import { createContact } from '../contacts/creation';

/**
 * Regression coverage for the four customer-webhook events that the registry
 * declared subscribable but that were never emitted at runtime:
 * `email.delivered`, `email.opened`, `email.clicked`, and `contact.created`.
 *
 * Rather than spin up a subscribed endpoint + mock the delivery fetch, we assert
 * the emission boundary directly: each reducer / the create chokepoint must
 * schedule `webhooks.deliveryQueries.enqueueFanoutDeliveries` with the correct
 * event literal and payload. The fanout itself (subscriber lookup + signed
 * delivery) is covered separately under webhooks/__tests__.
 */

const modules = import.meta.glob('../**/*.*s');

async function createThroughModule(
	t: ReturnType<typeof convexTest>,
	args: Parameters<typeof createContact>[1]
) {
	return t.run((ctx) => createContact(ctx, args));
}

type Fanout = { event: string; data: Record<string, unknown> };

/** The fanout jobs the just-run mutation scheduled, by event literal. */
async function scheduledFanouts(t: ReturnType<typeof convexTest>): Promise<Fanout[]> {
	return await t.run(async (ctx) => {
		const jobs = await ctx.db.system.query('_scheduled_functions').collect();
		const out: Fanout[] = [];
		for (const job of jobs) {
			if (job.name !== 'webhooks/deliveryQueries:enqueueFanoutDeliveries') continue;
			const arg = job.args[0] as { event: string; payload: { data: Record<string, unknown> } };
			out.push({ event: arg.event, data: arg.payload.data });
		}
		return out;
	});
}

async function seedSentCampaignSend(
	t: ReturnType<typeof convexTest>,
	contactEmail = 'recipient@example.com'
): Promise<Id<'emailSends'>> {
	let sendId!: Id<'emailSends'>;
	await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contactId = await ctx.db.insert('contacts', createTestContact());
		sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({ campaignId, contactId, status: 'sent', contactEmail })
		);
	});
	return sendId;
}

describe('webhook emission — email.delivered', () => {
	it('fans out email.delivered once on the delivered transition', async () => {
		const t = convexTest(schema, modules);
		const sendId = await seedSentCampaignSend(t, 'deliver@example.com');

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'delivered', at: 1000 },
		});

		const delivered = (await scheduledFanouts(t)).filter((f) => f.event === 'email.delivered');
		expect(delivered).toHaveLength(1);
		expect(delivered[0]!.data['email']).toBe('deliver@example.com');
		expect(delivered[0]!.data['timestamp']).toBe(new Date(1000).toISOString());
	});

	it('does not re-fan email.delivered on a duplicate delivered transition', async () => {
		const t = convexTest(schema, modules);
		const sendId = await seedSentCampaignSend(t);

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'delivered', at: 1000 },
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'delivered', at: 2000 },
		});

		const delivered = (await scheduledFanouts(t)).filter((f) => f.event === 'email.delivered');
		expect(delivered).toHaveLength(1);
	});
});

describe('webhook emission — email.opened', () => {
	it('fans out email.opened only on the first open', async () => {
		const t = convexTest(schema, modules);
		const sendId = await seedSentCampaignSend(t, 'open@example.com');

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'opened', at: 1000 },
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'opened', at: 2000 },
		});

		const opened = (await scheduledFanouts(t)).filter((f) => f.event === 'email.opened');
		expect(opened).toHaveLength(1);
		expect(opened[0]!.data['email']).toBe('open@example.com');
	});
});

describe('webhook emission — email.clicked', () => {
	it('fans out email.clicked on every click, each carrying its url', async () => {
		const t = convexTest(schema, modules);
		const sendId = await seedSentCampaignSend(t, 'click@example.com');

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'clicked', at: 1000, url: 'https://example.com/a' },
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'clicked', at: 2000, url: 'https://example.com/b' },
		});

		const clicked = (await scheduledFanouts(t)).filter((f) => f.event === 'email.clicked');
		expect(clicked).toHaveLength(2);
		expect(clicked.map((c) => c.data['url']).sort()).toEqual([
			'https://example.com/a',
			'https://example.com/b',
		]);
		expect(clicked.every((c) => c.data['email'] === 'click@example.com')).toBe(true);
	});
});

/** A queued send created through the transactional API, and its template. */
async function seedApiSend(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => {
		const templateId = await ctx.db.insert('transactionalEmails', createTestTransactionalEmail());
		const sendId = await ctx.db.insert('transactionalSends', {
			kind: 'transactional' as const,
			transactionalEmailId: templateId,
			email: 'api@example.com',
			status: 'queued' as const,
			queuedAt: 1,
		});
		return { sendId, templateId };
	});
}

describe('webhook emission — email.failed', () => {
	it('fans out exactly one email.failed naming the send and its error code', async () => {
		const t = convexTest(schema, modules);
		const { sendId, templateId } = await seedApiSend(t);
		const failed = {
			to: 'failed' as const,
			at: 1000,
			errorMessage: 'Delivery stayed on hold until the delivery deadline passed',
			errorCode: 'DELIVERY_HOLD_EXPIRED',
		};

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: sendId },
			transition: failed,
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: sendId },
			transition: { ...failed, at: 2000, errorCode: 'WORKPOOL_FAILED' },
		});

		const fanouts = await scheduledFanouts(t);
		expect(fanouts.map((f) => f.event)).toEqual(['email.failed']);
		expect(fanouts[0]!.data).toEqual({
			email: 'api@example.com',
			sendId,
			campaignId: null,
			templateId,
			errorCode: 'DELIVERY_HOLD_EXPIRED',
			message: 'Delivery stayed on hold until the delivery deadline passed',
			timestamp: new Date(1000).toISOString(),
		});
	});
});

describe('webhook emission — every email event names its send', () => {
	it('carries the send id the API returned on each event of one send', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await seedApiSend(t);
		const transitions = [
			{ to: 'sent' as const, at: 1000, providerMessageId: 'pm-1' },
			{ to: 'delivered' as const, at: 2000 },
			{ to: 'opened' as const, at: 3000 },
			{ to: 'clicked' as const, at: 4000, url: 'https://example.com/a' },
			{ to: 'complained' as const, at: 5000 },
		];
		for (const transition of transitions) {
			await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'transactional', id: sendId },
				transition,
			});
		}

		const fanouts = await scheduledFanouts(t);
		expect(fanouts.map((f) => f.event).sort()).toEqual([
			'email.clicked',
			'email.complained',
			'email.delivered',
			'email.opened',
			'email.sent',
		]);
		for (const fanout of fanouts) {
			expect(fanout.data['sendId'], fanout.event).toBe(sendId);
		}
	});
});

describe('webhook emission — contact.created', () => {
	it('fans out contact.created for a genuinely-new email contact, tagged with source', async () => {
		const t = convexTest(schema, modules);

		const res = await createThroughModule(t, {
			channel: 'email',
			identifier: 'new@example.com',
			source: 'api',
			mode: 'strict',
		});

		const created = (await scheduledFanouts(t)).filter((f) => f.event === 'contact.created');
		expect(created).toHaveLength(1);
		expect(created[0]!.data['email']).toBe('new@example.com');
		expect(created[0]!.data['source']).toBe('api');
		expect(created[0]!.data['contactId']).toBe(String(res.contactId));
	});

	it('does not re-fan contact.created when an upsert matches an existing contact', async () => {
		const t = convexTest(schema, modules);

		await createThroughModule(t, {
			channel: 'email',
			identifier: 'dup@example.com',
			source: 'api',
			mode: 'strict',
		});
		await createThroughModule(t, {
			channel: 'email',
			identifier: 'dup@example.com',
			source: 'inbound',
			mode: 'upsert',
		});

		const created = (await scheduledFanouts(t)).filter((f) => f.event === 'contact.created');
		expect(created).toHaveLength(1);
	});

	it('does not fan out contact.created for a non-email channel (no address to report)', async () => {
		const t = convexTest(schema, modules);

		await createThroughModule(t, {
			channel: 'sms',
			identifier: '+15551230000',
			source: 'inbound',
			mode: 'upsert',
		});

		const created = (await scheduledFanouts(t)).filter((f) => f.event === 'contact.created');
		expect(created).toHaveLength(0);
	});
});
