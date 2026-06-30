import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
} from './factories';
import type { Id } from '../_generated/dataModel';

/**
 * Regression coverage for the four customer-webhook events that the registry
 * declared subscribable but that were never emitted at runtime:
 * `email.delivered`, `email.opened`, `email.clicked`, and `contact.created`.
 *
 * Rather than spin up a subscribed endpoint + mock the delivery fetch, we assert
 * the emission boundary directly: each reducer / the create chokepoint must
 * schedule `webhooks.fanout.fanoutEvent` with the correct event literal and
 * payload. The fanout action itself (subscriber lookup + signed delivery) is
 * covered separately in webhooks.integration.test.ts.
 */

const modules = import.meta.glob('../**/*.*s');

type Fanout = { event: string; data: Record<string, unknown> };

/** The fanoutEvent jobs the just-run mutation scheduled, by event literal. */
async function scheduledFanouts(
	t: ReturnType<typeof convexTest>
): Promise<Fanout[]> {
	return await t.run(async (ctx) => {
		const jobs = await ctx.db.system.query('_scheduled_functions').collect();
		const out: Fanout[] = [];
		for (const job of jobs) {
			const arg = job.args[0] as { event?: unknown; data?: unknown } | undefined;
			if (arg && typeof arg.event === 'string') {
				out.push({ event: arg.event, data: (arg.data ?? {}) as Record<string, unknown> });
			}
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

describe('webhook emission — contact.created', () => {
	it('fans out contact.created for a genuinely-new email contact, tagged with source', async () => {
		const t = convexTest(schema, modules);

		const res = await t.mutation(internal.contacts.creation.create, {
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

		await t.mutation(internal.contacts.creation.create, {
			channel: 'email',
			identifier: 'dup@example.com',
			source: 'api',
			mode: 'strict',
		});
		await t.mutation(internal.contacts.creation.create, {
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

		await t.mutation(internal.contacts.creation.create, {
			channel: 'sms',
			identifier: '+15551230000',
			source: 'inbound',
			mode: 'upsert',
		});

		const created = (await scheduledFanouts(t)).filter((f) => f.event === 'contact.created');
		expect(created).toHaveLength(0);
	});
});
