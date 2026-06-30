import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestConversationThread, createTestContact, createTestUnifiedMessage, createTestChannelConfig } from './factories';
import type { Id } from '../_generated/dataModel';

/** Create a valid conversation thread for DB insertion (strips fields not in schema) */
function threadData(overrides: Record<string, unknown> = {}) {
	const { channel, contactId, updatedAt, ...data } = createTestConversationThread(overrides);
	return data;
}

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({ subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' }),
	};
});

vi.mock('../lib/posthogHelpers', async () => ({
	trackEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
		!path.includes('sesActions') && !path.includes('agentSecurity') && !path.includes('agentContext') && !path.includes('agentClassifier') && !path.includes('agentDrafter') && !path.includes('agentRouter') &&
		!path.includes('agent/walker') &&
		!path.includes('agent/steps/index') &&
		!path.includes('agent/steps/shared') &&
		!path.includes('agent/steps/classify') &&
		!path.includes('agent/steps/draft') && !path.includes('knowledgeExtraction') && !path.includes('semanticFileProcessing') && !path.includes('visualizationAgent') && !path.includes('llmProvider')
	)
);

// ============ getThreadTimeline ============

describe('unifiedMessages.getThreadTimeline', () => {
	it('should return messages for a thread in ascending order', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			threadId = await ctx.db.insert('conversationThreads', threadData());

			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				content: JSON.stringify({ text: 'First message' }),
				createdAt: Date.now() - 2000,
			}));
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				content: JSON.stringify({ text: 'Second message' }),
				createdAt: Date.now() - 1000,
			}));
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				content: JSON.stringify({ text: 'Third message' }),
				createdAt: Date.now(),
			}));
		});

		const messages = await t.query(api.unifiedMessages.getThreadTimeline, { threadId });
		expect(messages).toHaveLength(3);
		expect(messages[0]!.content.text).toBe('First message');
		expect(messages[2]!.content.text).toBe('Third message');
	});

	it('should return empty array for empty thread', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			threadId = await ctx.db.insert('conversationThreads', threadData());
		});

		const messages = await t.query(api.unifiedMessages.getThreadTimeline, { threadId });
		expect(messages).toEqual([]);
	});
});

// ============ getContactTimeline ============

describe('unifiedMessages.getContactTimeline', () => {
	it('should return messages for a contact in descending order', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		let threadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData());

			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				contactId,
				content: JSON.stringify({ text: 'Older' }),
				createdAt: Date.now() - 1000,
			}));
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				contactId,
				content: JSON.stringify({ text: 'Newer' }),
				createdAt: Date.now(),
			}));
		});

		const messages = await t.query(api.unifiedMessages.getContactTimeline, { contactId });
		expect(messages).toHaveLength(2);
		// desc order: newer first
		expect(messages[0]!.content.text).toBe('Newer');
		expect(messages[1]!.content.text).toBe('Older');
	});

	it('interleaves mirrored email rows with channel rows for a contact', async () => {
		const t = convexTest(schema, modules);
		let contactId!: Id<'contacts'>;
		let threadId!: Id<'conversationThreads'>;
		const base = Date.now();

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData());

			// Customer emailed in (mirrored inbound email)…
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				contactId,
				channel: 'email',
				direction: 'inbound',
				content: JSON.stringify({ text: 'inbound email', subject: 'Hi' }),
				createdAt: base - 3000,
			}));
			// …then an SMS came in on another channel…
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				contactId,
				channel: 'sms',
				direction: 'inbound',
				content: JSON.stringify({ text: 'sms ping' }),
				createdAt: base - 2000,
			}));
			// …then the agent replied by email (mirrored outbound email).
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				contactId,
				channel: 'email',
				direction: 'outbound',
				status: 'sent',
				content: JSON.stringify({ text: 'agent reply', subject: 'Re: Hi' }),
				createdAt: base - 1000,
			}));
		});

		const messages = await t.query(api.unifiedMessages.getContactTimeline, { contactId });
		// All three channels/directions are interleaved, newest first.
		expect(messages.map((m) => `${m.channel}:${m.direction}`)).toEqual([
			'email:outbound',
			'sms:inbound',
			'email:inbound',
		]);
	});
});

// ============ listRecent ============

describe('unifiedMessages.listRecent', () => {
	it('should return recent messages across all channels', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('conversationThreads', threadData());

			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				channel: 'email',
				createdAt: Date.now() - 1000,
			}));
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				channel: 'chat',
				createdAt: Date.now(),
			}));
		});

		const messages = await t.query(api.unifiedMessages.listRecent, {});
		expect(messages).toHaveLength(2);
	});

	it('should filter by channel when specified', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('conversationThreads', threadData());

			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({ threadId, channel: 'email' }));
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({ threadId, channel: 'chat' }));
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({ threadId, channel: 'email' }));
		});

		const emails = await t.query(api.unifiedMessages.listRecent, { channel: 'email' });
		expect(emails).toHaveLength(2);
		for (const msg of emails) {
			expect(msg.channel).toBe('email');
		}
	});

	it('requires the shared-inbox owner/admin permission', async () => {
		const { requireOrgPermission } = await import('../lib/sessionOrganization');
		const mock = vi.mocked(requireOrgPermission);
		mock.mockClear();

		const t = convexTest(schema, modules);
		await t.query(api.unifiedMessages.listRecent, {});
		expect(mock).toHaveBeenCalledWith(expect.anything(), 'organization:manage');

		mock.mockRejectedValueOnce(new Error('Insufficient permissions'));
		await expect(t.query(api.unifiedMessages.listRecent, {})).rejects.toThrow('Insufficient permissions');
	});
});

// ============ recordInbound (internal) ============

describe('unifiedMessages.recordInbound', () => {
	it('should record an inbound message', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			threadId = await ctx.db.insert('conversationThreads', threadData());
		});

		const msgId = await t.mutation(internal.unifiedMessages.recordInbound, {
			threadId,
			channel: 'email',
			content: JSON.stringify({ text: 'Hello from customer' }),
			externalMessageId: 'ext-123',
		});

		expect(msgId).toBeDefined();

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(msgId);
			expect(msg).not.toBeNull();
			expect(msg!.direction).toBe('inbound');
			expect(msg!.status).toBe('received');
			expect(msg!.channel).toBe('email');
		});
	});
});

// ============ recordOutbound (internal) ============

describe('unifiedMessages.recordOutbound', () => {
	it('should record an outbound message with default queued status', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			threadId = await ctx.db.insert('conversationThreads', threadData());
		});

		const msgId = await t.mutation(internal.unifiedMessages.recordOutbound, {
			threadId,
			channel: 'sms',
			content: JSON.stringify({ text: 'Reply from agent' }),
		});

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(msgId);
			expect(msg!.direction).toBe('outbound');
			expect(msg!.status).toBe('queued');
			expect(msg!.channel).toBe('sms');
		});
	});

	it('should record an outbound message with explicit status', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			threadId = await ctx.db.insert('conversationThreads', threadData());
		});

		const msgId = await t.mutation(internal.unifiedMessages.recordOutbound, {
			threadId,
			channel: 'whatsapp',
			content: JSON.stringify({ text: 'Sent reply' }),
			status: 'sent',
		});

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(msgId);
			expect(msg!.status).toBe('sent');
		});
	});
});

// ============ lastSuccessfulSend stamping across channels ============

/**
 * `channelConfigs.lastSuccessfulSend` backs the dashboard channel card's "Last
 * Successful Send" stat and has exactly one writer:
 * `stampChannelLastSuccessfulSend`, fired from every successful-send writer.
 * Email (the primary, default channel) records outbound through
 * `mirrorEmailSend`/`mirrorEmailSendWrite` — NOT `recordOutbound` — so without a
 * stamp there the email card would read "Never" after real sends. Chat is
 * terminal-on-insert. These cover all three paths.
 */
describe('unifiedMessages lastSuccessfulSend stamping', () => {
	it('stamps the email channel config when a confirmed email send is mirrored', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;
		let contactId!: Id<'contacts'>;
		let configId!: Id<'channelConfigs'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			configId = await ctx.db.insert(
				'channelConfigs',
				createTestChannelConfig({ channel: 'email', isEnabled: true }),
			);
		});

		const before = Date.now();
		await t.mutation(internal.unifiedMessages.mirrorEmailSend, {
			threadId,
			contactId,
			subject: 'Re: hello',
			textBody: 'agent reply',
			externalMessageId: 'msg-email-1',
			status: 'sent',
		});

		const config = await t.run((ctx) => ctx.db.get(configId));
		expect(config!.lastSuccessfulSend).toBeGreaterThanOrEqual(before);
	});

	it('does not stamp the email channel config when the mirrored row is not a successful send', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;
		let contactId!: Id<'contacts'>;
		let configId!: Id<'channelConfigs'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			configId = await ctx.db.insert(
				'channelConfigs',
				createTestChannelConfig({ channel: 'email', isEnabled: true }),
			);
		});

		await t.mutation(internal.unifiedMessages.mirrorEmailSend, {
			threadId,
			contactId,
			externalMessageId: 'msg-email-fail-1',
			status: 'failed',
		});

		const config = await t.run((ctx) => ctx.db.get(configId));
		expect(config!.lastSuccessfulSend).toBeUndefined();
	});

	it('does not back-date the email stamp on a re-fired (idempotent) mirror', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;
		let contactId!: Id<'contacts'>;
		let configId!: Id<'channelConfigs'>;

		await t.run(async (ctx) => {
			contactId = await ctx.db.insert('contacts', createTestContact());
			threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
			configId = await ctx.db.insert(
				'channelConfigs',
				createTestChannelConfig({ channel: 'email', isEnabled: true }),
			);
		});

		await t.mutation(internal.unifiedMessages.mirrorEmailSend, {
			threadId,
			contactId,
			externalMessageId: 'msg-email-dup-1',
			status: 'sent',
		});
		const first = await t.run((ctx) => ctx.db.get(configId));
		const firstStamp = first!.lastSuccessfulSend;
		expect(firstStamp).toBeGreaterThan(0);

		// Re-deliver the same provider message id: the mirror dedupe early-returns
		// before the stamp, so the timestamp must not move.
		await t.mutation(internal.unifiedMessages.mirrorEmailSend, {
			threadId,
			contactId,
			externalMessageId: 'msg-email-dup-1',
			status: 'sent',
		});
		const second = await t.run((ctx) => ctx.db.get(configId));
		expect(second!.lastSuccessfulSend).toBe(firstStamp);
	});

	it('stamps the chat channel config when a chat message is sent', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;
		let configId!: Id<'channelConfigs'>;

		await t.run(async (ctx) => {
			threadId = await ctx.db.insert('conversationThreads', threadData());
			configId = await ctx.db.insert(
				'channelConfigs',
				createTestChannelConfig({ channel: 'chat', isEnabled: true }),
			);
		});

		const before = Date.now();
		await t.mutation(api.unifiedMessages.sendChatMessage, {
			threadId,
			text: 'Hello from the team!',
		});

		const config = await t.run((ctx) => ctx.db.get(configId));
		expect(config!.lastSuccessfulSend).toBeGreaterThanOrEqual(before);
	});
});

// ============ updateDeliveryStatus (internal) ============

describe('unifiedMessages.updateDeliveryStatus', () => {
	it('should update the status of a message', async () => {
		const t = convexTest(schema, modules);
		let msgId!: Id<'unifiedMessages'>;

		await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('conversationThreads', threadData());
			msgId = await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId,
				direction: 'outbound',
				status: 'queued',
			}));
		});

		await t.mutation(internal.unifiedMessages.updateDeliveryStatus, {
			messageId: msgId,
			status: 'delivered',
		});

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(msgId);
			expect(msg!.status).toBe('delivered');
		});
	});
});

// ============ listPendingDeliveryStatus (internal) ============

describe('unifiedMessages.listPendingDeliveryStatus', () => {
	it('returns only outbound sent channel messages with an externalMessageId, within the window', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		let threadId!: Id<'conversationThreads'>;
		let smsId!: Id<'unifiedMessages'>;
		let whatsappId!: Id<'unifiedMessages'>;
		let genericId!: Id<'unifiedMessages'>;

		await t.run(async (ctx) => {
			threadId = await ctx.db.insert('conversationThreads', threadData());

			// SHOULD be picked: outbound, sent, channel, has externalMessageId, recent.
			smsId = await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId, channel: 'sms', direction: 'outbound', status: 'sent',
				externalMessageId: 'SM123', createdAt: now,
			}));
			whatsappId = await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId, channel: 'whatsapp', direction: 'outbound', status: 'sent',
				externalMessageId: 'wamid.1', createdAt: now - 1000,
			}));
			genericId = await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId, channel: 'generic', direction: 'outbound', status: 'sent',
				externalMessageId: 'web-1', createdAt: now - 2000,
			}));

			// NOT picked: email channel (owned by MTA pipeline).
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId, channel: 'email', direction: 'outbound', status: 'sent',
				externalMessageId: 'msg-email', createdAt: now,
			}));
			// NOT picked: already delivered (terminal/progressed).
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId, channel: 'sms', direction: 'outbound', status: 'delivered',
				externalMessageId: 'SM-done', createdAt: now,
			}));
			// NOT picked: inbound.
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId, channel: 'sms', direction: 'inbound', status: 'sent',
				externalMessageId: 'SM-in', createdAt: now,
			}));
			// NOT picked: no externalMessageId to poll on.
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId, channel: 'sms', direction: 'outbound', status: 'sent',
				createdAt: now,
			}));
			// NOT picked: outside the window (older than sinceMs).
			await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
				threadId, channel: 'sms', direction: 'outbound', status: 'sent',
				externalMessageId: 'SM-old', createdAt: now - 60_000,
			}));
		});

		const pending = await t.query(internal.unifiedMessages.listPendingDeliveryStatus, {
			sinceMs: 10_000,
			limit: 100,
		});

		expect(new Set(pending.map((p) => p.messageId))).toEqual(
			new Set([smsId, whatsappId, genericId]),
		);
		expect(pending.every((p) => typeof p.externalMessageId === 'string')).toBe(true);
		expect(pending.every((p) => ['sms', 'whatsapp', 'generic'].includes(p.channel))).toBe(true);
	});

	it('respects the limit', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await t.run(async (ctx) => {
			const threadId = await ctx.db.insert('conversationThreads', threadData());
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert('unifiedMessages', createTestUnifiedMessage({
					threadId, channel: 'sms', direction: 'outbound', status: 'sent',
					externalMessageId: `SM-${i}`, createdAt: now - i,
				}));
			}
		});

		const pending = await t.query(internal.unifiedMessages.listPendingDeliveryStatus, {
			sinceMs: 60_000,
			limit: 2,
		});
		expect(pending).toHaveLength(2);
	});
});

// ============ sendChatMessage (user mutation) ============

describe('unifiedMessages.sendChatMessage', () => {
	it('should create a chat message with delivered status', async () => {
		const t = convexTest(schema, modules);
		let threadId!: Id<'conversationThreads'>;

		await t.run(async (ctx) => {
			threadId = await ctx.db.insert('conversationThreads', threadData());
		});

		const msgId = await t.mutation(api.unifiedMessages.sendChatMessage, {
			threadId,
			text: 'Hello from the team!',
		});

		expect(msgId).toBeDefined();

		await t.run(async (ctx) => {
			const msg = await ctx.db.get(msgId);
			expect(msg!.channel).toBe('chat');
			expect(msg!.direction).toBe('outbound');
			expect(msg!.status).toBe('delivered');
			const content = JSON.parse(msg!.content);
			expect(content.text).toBe('Hello from the team!');
		});
	});
});

// ============ updateChannelConfig (user mutation) ============

describe('unifiedMessages.updateChannelConfig', () => {
	it('should create a new channel config when none exists', async () => {
		const t = convexTest(schema, modules);

		const configId = await t.mutation(api.unifiedMessages.updateChannelConfig, {
			channel: 'sms',
			isEnabled: true,
			displayName: 'SMS Channel',
		});

		expect(configId).toBeDefined();

		await t.run(async (ctx) => {
			const config = await ctx.db.get(configId);
			expect(config!.channel).toBe('sms');
			expect(config!.isEnabled).toBe(true);
			expect(config!.displayName).toBe('SMS Channel');
		});
	});

	it('should update an existing channel config', async () => {
		const t = convexTest(schema, modules);
		let configId!: Id<'channelConfigs'>;

		await t.run(async (ctx) => {
			configId = await ctx.db.insert('channelConfigs', createTestChannelConfig({
				channel: 'email',
				isEnabled: true,
				displayName: 'Email',
			}));
		});

		await t.mutation(api.unifiedMessages.updateChannelConfig, {
			channel: 'email',
			isEnabled: false,
			displayName: 'Email (Disabled)',
		});

		await t.run(async (ctx) => {
			const config = await ctx.db.get(configId);
			expect(config!.isEnabled).toBe(false);
			expect(config!.displayName).toBe('Email (Disabled)');
		});
	});
});

// ============ updateChannelHealth (internal) ============

describe('unifiedMessages.updateChannelHealth', () => {
	it('should update health status on an existing channel config', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('channelConfigs', createTestChannelConfig({
				channel: 'sms',
				isEnabled: true,
			}));
		});

		await t.mutation(internal.unifiedMessages.updateChannelHealth, {
			channel: 'sms',
			healthStatus: 'degraded',
			lastError: 'Twilio rate limit',
		});

		await t.run(async (ctx) => {
			const config = await ctx.db
				.query('channelConfigs')
				.withIndex('by_channel', (q) => q.eq('channel', 'sms'))
				.first();
			expect(config!.healthStatus).toBe('degraded');
			expect(config!.lastError).toBe('Twilio rate limit');
			expect(config!.lastHealthCheckAt).toBeTypeOf('number');
		});
	});

	it('should do nothing if channel config does not exist', async () => {
		const t = convexTest(schema, modules);
		// Should not throw
		await t.mutation(internal.unifiedMessages.updateChannelHealth, {
			channel: 'generic',
			healthStatus: 'down',
		});
	});
});

// ============ runChannelHealthChecks (cron) ============

describe('unifiedMessages.runChannelHealthChecks', () => {
	it('marks an enabled-but-unconfigured non-email channel as down', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('channelConfigs', createTestChannelConfig({
				channel: 'sms',
				isEnabled: true,
				// no `config` blob → no credentials
			}));
		});

		await t.action(internal.unifiedMessages.runChannelHealthChecks);

		await t.run(async (ctx) => {
			const config = await ctx.db
				.query('channelConfigs')
				.withIndex('by_channel', (q) => q.eq('channel', 'sms'))
				.first();
			expect(config!.healthStatus).toBe('down');
			expect(config!.lastError).toBe('No credentials configured');
		});
	});

	it('does NOT report a configured-but-undecryptable channel as healthy (runs the real probe)', async () => {
		// Regression: previously any sms/whatsapp/generic channel with a config
		// blob present was written `healthy` off mere presence. The cron now runs
		// the adapter's healthCheck() probe via channels.outbound.probeChannelHealth,
		// so creds that cannot even be decrypted (here: a non-envelope blob) surface
		// as `down` instead of green.
		process.env['INSTANCE_SECRET'] = 'test-instance-secret';
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('channelConfigs', createTestChannelConfig({
				channel: 'sms',
				isEnabled: true,
				config: 'not-a-valid-encrypted-envelope',
			}));
		});

		await t.action(internal.unifiedMessages.runChannelHealthChecks);

		await t.run(async (ctx) => {
			const config = await ctx.db
				.query('channelConfigs')
				.withIndex('by_channel', (q) => q.eq('channel', 'sms'))
				.first();
			expect(config!.healthStatus).not.toBe('healthy');
			expect(config!.healthStatus).toBe('down');
		});
	});

	it('still reports email channels healthy off config presence', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('channelConfigs', createTestChannelConfig({
				channel: 'email',
				isEnabled: true,
			}));
		});

		await t.action(internal.unifiedMessages.runChannelHealthChecks);

		await t.run(async (ctx) => {
			const config = await ctx.db
				.query('channelConfigs')
				.withIndex('by_channel', (q) => q.eq('channel', 'email'))
				.first();
			expect(config!.healthStatus).toBe('healthy');
		});
	});
});
