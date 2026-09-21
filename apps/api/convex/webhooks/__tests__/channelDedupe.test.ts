import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';

/**
 * Replay-dedupe for inbound channel webhooks (L12).
 *
 * The Twilio / Meta / generic channel signatures carry no timestamp, so a
 * captured-and-replayed (or provider-retried) inbound POST would otherwise fork
 * a duplicate `unifiedMessages` row. `processInboundChannel` dedupes on the
 * provider message id (`externalMessageId`), so a replay is a no-op.
 *
 * The `ai.agent` flag is left OFF, so these mutations exercise ONLY the durable
 * storage path (contact/thread/unifiedMessages) — no agent walker is scheduled.
 */
async function countMessages(t: ReturnType<typeof convexTest>): Promise<number> {
	return t.run(async (ctx) => (await ctx.db.query('unifiedMessages').collect()).length);
}

describe('processInboundChannel replay dedupe', () => {
	it('ingests a replayed SMS webhook (same MessageSid) exactly once', async () => {
		const t = convexTest(schema, modules);
		const args = {
			channel: 'sms' as const,
			from: '+15551234567',
			content: 'hello there',
			externalMessageId: 'SM-twilio-abc123',
		};

		await t.mutation(internal.webhooks.channels.processInboundChannel, args);
		// Replay: byte-identical retry of the same provider delivery.
		await t.mutation(internal.webhooks.channels.processInboundChannel, args);

		expect(await countMessages(t)).toBe(1);
	});

	it('stores distinct provider ids as distinct messages', async () => {
		const t = convexTest(schema, modules);
		const base = { channel: 'whatsapp' as const, from: '+15559999999', content: 'hi' };

		await t.mutation(internal.webhooks.channels.processInboundChannel, {
			...base,
			externalMessageId: 'wamid.AAA',
		});
		await t.mutation(internal.webhooks.channels.processInboundChannel, {
			...base,
			externalMessageId: 'wamid.BBB',
		});

		expect(await countMessages(t)).toBe(2);
	});

	it('does not dedupe when the provider supplied no id (cannot dedupe)', async () => {
		const t = convexTest(schema, modules);
		const args = { channel: 'generic' as const, from: 'webhook', content: 'ping' };

		await t.mutation(internal.webhooks.channels.processInboundChannel, args);
		await t.mutation(internal.webhooks.channels.processInboundChannel, args);

		// No externalMessageId → no dedupe key → both are stored (store-and-forward).
		expect(await countMessages(t)).toBe(2);
	});

	it('scopes dedupe by channel — the same id on a different channel is not a replay', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.webhooks.channels.processInboundChannel, {
			channel: 'sms' as const,
			from: '+15551112222',
			content: 'sms body',
			externalMessageId: 'shared-id',
		});
		await t.mutation(internal.webhooks.channels.processInboundChannel, {
			channel: 'generic' as const,
			from: 'webhook',
			content: 'generic body',
			externalMessageId: 'shared-id',
		});

		expect(await countMessages(t)).toBe(2);
	});
});
