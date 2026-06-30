import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestContact,
	createTestChannelConfig,
	createTestContactIdentity,
	createTestConversationThread,
	createTestUnifiedMessage,
} from './factories';
import type { Id } from '../_generated/dataModel';

/**
 * Covers the user-initiated outbound path added so SMS/WhatsApp/generic channel
 * credentials drive a manual send, not just the AI agent reply. The provider
 * dispatch (`dispatchOutbound`) stays fail-safe; this guards the manual
 * precondition seam (`resolveOutboundThread`): it throws loudly on a
 * misconfiguration and continues/opens the right conversation thread.
 */

/** Strip fields not on the conversationThreads schema (channel/updatedAt). */
function threadData(overrides: Record<string, unknown> = {}) {
	const { channel, updatedAt, ...data } = createTestConversationThread(overrides);
	return data;
}

const modules = import.meta.glob('../**/*.*s');

describe('unifiedMessages.resolveOutboundThread', () => {
	it('throws when the channel is not enabled', async () => {
		const t = convexTest(schema, modules);
		const contactId = await t.run((ctx) =>
			ctx.db.insert('contacts', createTestContact()),
		);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'sms', isEnabled: false })),
		);

		await expect(
			t.mutation(internal.unifiedMessages.resolveOutboundThread, {
				contactId,
				channel: 'sms',
			}),
		).rejects.toThrow(/not enabled/i);
	});

	it('throws when the contact is soft-deleted (GDPR-erased)', async () => {
		const t = convexTest(schema, modules);
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({ deletedAt: Date.now(), deletedBy: 'system' }),
			);
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId: id,
				channel: 'phone',
				identifier: '+15551234567',
			}));
			return id;
		});
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'sms', isEnabled: true })),
		);

		await expect(
			t.mutation(internal.unifiedMessages.resolveOutboundThread, {
				contactId,
				channel: 'sms',
			}),
		).rejects.toThrow(/Contact not found/i);
	});

	it('throws when an sms contact has no phone/sms address', async () => {
		const t = convexTest(schema, modules);
		const contactId = await t.run((ctx) =>
			ctx.db.insert('contacts', createTestContact({ email: 'x@example.com' })),
		);
		await t.run((ctx) =>
			ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'sms', isEnabled: true })),
		);

		await expect(
			t.mutation(internal.unifiedMessages.resolveOutboundThread, {
				contactId,
				channel: 'sms',
			}),
		).rejects.toThrow(/no sms address/i);
	});

	it('continues the contact\'s most recent thread for the channel', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		let existingThreadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'sms', isEnabled: true }));
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'phone',
				identifier: '+15551234567',
			}));
			existingThreadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId: existingThreadId,
				channel: 'sms',
				contactId,
			}));
		});

		const threadId = await t.mutation(internal.unifiedMessages.resolveOutboundThread, {
			contactId,
			channel: 'sms',
		});
		expect(threadId).toBe(existingThreadId);
	});

	it('opens a fresh thread when the contact has no prior thread on the channel', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact({ firstName: 'Ada', lastName: 'Lovelace' }));
			await ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'generic', isEnabled: true }));
		});

		const threadId = await t.mutation(internal.unifiedMessages.resolveOutboundThread, {
			contactId,
			channel: 'generic',
		});

		const thread = await t.run((ctx) => ctx.db.get(threadId));
		expect(thread).not.toBeNull();
		expect(thread!.contactId).toBe(contactId);
		expect(thread!.status).toBe('open');
		expect(thread!.subject).toContain('Ada Lovelace');
	});

	it('bumps the denormalized openThreads counter when opening a fresh thread', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'generic', isEnabled: true }));
			await ctx.db.insert('instanceSettings', { createdAt: Date.now(), openThreads: 0 });
		});

		await t.mutation(internal.unifiedMessages.resolveOutboundThread, {
			contactId,
			channel: 'generic',
		});

		const openThreads = await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			return settings!.openThreads;
		});
		expect(openThreads).toBe(1);
	});

	it('leaves the openThreads counter untouched when continuing an existing thread', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.insert('channelConfigs', createTestChannelConfig({ channel: 'sms', isEnabled: true }));
			await ctx.db.insert('contactIdentities', createTestContactIdentity({
				contactId,
				channel: 'phone',
				identifier: '+15551234567',
			}));
			const existingThreadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId: existingThreadId,
				channel: 'sms',
				contactId,
			}));
			// Seed the counter to a non-zero value reflecting the existing open
			// thread; continuing it must not re-bump.
			await ctx.db.insert('instanceSettings', { createdAt: Date.now(), openThreads: 1 });
		});

		await t.mutation(internal.unifiedMessages.resolveOutboundThread, {
			contactId,
			channel: 'sms',
		});

		const openThreads = await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			return settings!.openThreads;
		});
		expect(openThreads).toBe(1);
	});
});

/**
 * `recordOutbound` is the timeline writer reached from
 * `channels.outbound.dispatchOutbound`'s `record('sent')` for the
 * SMS/WhatsApp/generic channels. Stamping `lastSuccessfulSend` on the channel's
 * `channelConfigs` row there is part of what gives the dashboard channel card its
 * "Last Successful Send" signal. (Email stamps via `mirrorEmailSendWrite` and
 * chat via `sendChatMessage` — see unifiedMessages.integration.test.ts.)
 */
describe('unifiedMessages.recordOutbound', () => {
	it('stamps lastSuccessfulSend on the channel config when status is sent', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		let threadId!: Id<'conversationThreads'>;
		let configId!: Id<'channelConfigs'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			configId = await ctx.db.insert(
				'channelConfigs',
				createTestChannelConfig({ channel: 'sms', isEnabled: true }),
			);
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
		});

		const before = Date.now();
		await t.mutation(internal.unifiedMessages.recordOutbound, {
			threadId,
			channel: 'sms',
			contactId,
			content: JSON.stringify({ text: 'hi' }),
			externalMessageId: 'ext-1',
			status: 'sent',
		});

		const config = await t.run((ctx) => ctx.db.get(configId));
		expect(config!.lastSuccessfulSend).toBeGreaterThanOrEqual(before);
	});

	it('leaves lastSuccessfulSend unset when the outbound row is not sent', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		let threadId!: Id<'conversationThreads'>;
		let configId!: Id<'channelConfigs'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			configId = await ctx.db.insert(
				'channelConfigs',
				createTestChannelConfig({ channel: 'sms', isEnabled: true }),
			);
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
		});

		await t.mutation(internal.unifiedMessages.recordOutbound, {
			threadId,
			channel: 'sms',
			contactId,
			content: JSON.stringify({ error: 'boom' }),
			status: 'failed',
		});

		const config = await t.run((ctx) => ctx.db.get(configId));
		expect(config!.lastSuccessfulSend).toBeUndefined();
	});
});
