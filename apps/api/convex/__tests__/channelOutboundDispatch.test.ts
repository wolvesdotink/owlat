import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestChannelConfig,
	createTestContact,
	createTestConversationThread,
	createTestInboundMessage,
	createTestUnifiedMessage,
} from './factories';

/**
 * What the channel dispatch and the delivery-status poll write: the outbound
 * timeline row, the approved reply's lifecycle step and the polled statuses.
 * The provider is the generic webhook adapter with its send and status calls
 * stubbed; credential decryption is stubbed so a configured row needs no key.
 */

const provider = vi.hoisted(() => ({
	send: vi.fn(),
	getDeliveryStatus: vi.fn(),
}));

vi.mock('../channels/credentials', async (importOriginal) => ({
	...(await importOriginal<typeof import('../channels/credentials')>()),
	decryptChannelCreds: () => ({ endpointUrl: 'https://hooks.owlat.example/out' }),
}));

vi.mock('../channels/adapters', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../channels/adapters')>();
	class StubWebhookAdapter extends actual.WebhookAdapter {
		override async send(...args: Parameters<InstanceType<typeof actual.WebhookAdapter>['send']>) {
			return provider.send(...args);
		}
		override async getDeliveryStatus(externalMessageId: string) {
			return provider.getDeliveryStatus(externalMessageId);
		}
	}
	return { ...actual, WebhookAdapter: StubWebhookAdapter };
});

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	provider.send.mockReset();
	provider.getDeliveryStatus.mockReset();
});

function threadData(overrides: Record<string, unknown> = {}) {
	const {
		channel: _channel,
		updatedAt: _updatedAt,
		...data
	} = createTestConversationThread(overrides);
	return data;
}

async function seed(options: { isConfigured: boolean }) {
	const t = convexTest(schema, modules);
	const ids = await t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact());
		const threadId = await ctx.db.insert('conversationThreads', threadData({ contactId }));
		const inboundMessageId = await ctx.db.insert(
			'inboundMessages',
			createTestInboundMessage({ contactId, threadId, processingStatus: 'approved' })
		);
		if (options.isConfigured) {
			await ctx.db.insert(
				'channelConfigs',
				createTestChannelConfig({ channel: 'generic', isEnabled: true, config: 'sealed' })
			);
		}
		return { contactId, threadId, inboundMessageId };
	});
	return { t, ...ids };
}

async function outboundRows(t: ReturnType<typeof convexTest>, threadId: Id<'conversationThreads'>) {
	return await t.run(async (ctx) =>
		(await ctx.db.query('unifiedMessages').collect()).filter(
			(row) => row.threadId === threadId && row.direction === 'outbound'
		)
	);
}

describe('channels.outbound.dispatchOutbound', () => {
	it('records a failed row and fails the approved reply when the channel is not configured', async () => {
		const { t, contactId, threadId, inboundMessageId } = await seed({ isConfigured: false });
		await t.action(internal.channels.outbound.dispatchOutbound, {
			channel: 'generic',
			contactId,
			threadId,
			content: { text: 'Hello' },
			inboundMessageId,
		});

		const rows = await outboundRows(t, threadId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'failed', channel: 'generic', contactId });
		expect(JSON.parse(rows[0]!.metadata!)).toEqual({ error: 'Channel not configured' });
		const inbound = await t.run(async (ctx) => await ctx.db.get(inboundMessageId));
		expect(inbound!.processingStatus).toBe('failed');
		expect(inbound!.errorMessage).toBe('Channel not configured');
		expect(provider.send).not.toHaveBeenCalled();
	});

	it('records the sent row, stamps the channel and sends the approved reply on acceptance', async () => {
		const { t, contactId, threadId, inboundMessageId } = await seed({ isConfigured: true });
		provider.send.mockResolvedValue({ success: true, externalMessageId: 'ext-1' });
		await t.action(internal.channels.outbound.dispatchOutbound, {
			channel: 'generic',
			contactId,
			threadId,
			content: { text: 'Hello' },
			inboundMessageId,
		});

		const rows = await outboundRows(t, threadId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'sent', externalMessageId: 'ext-1' });
		expect(rows[0]!.metadata).toBeUndefined();
		const inbound = await t.run(async (ctx) => await ctx.db.get(inboundMessageId));
		expect(inbound!.processingStatus).toBe('sent');
		const config = await t.run(async (ctx) => await ctx.db.query('channelConfigs').first());
		expect(config!.lastSuccessfulSend).toEqual(expect.any(Number));
	});

	it('records the provider refusal with its id and error', async () => {
		const { t, contactId, threadId, inboundMessageId } = await seed({ isConfigured: true });
		provider.send.mockResolvedValue({ success: false, externalMessageId: 'ext-2', error: 'nope' });
		await t.action(internal.channels.outbound.dispatchOutbound, {
			channel: 'generic',
			contactId,
			threadId,
			content: { text: 'Hello' },
			inboundMessageId,
		});

		const [row] = await outboundRows(t, threadId);
		expect(row).toMatchObject({ status: 'failed', externalMessageId: 'ext-2' });
		expect(JSON.parse(row!.metadata!)).toEqual({ error: 'nope' });
		const inbound = await t.run(async (ctx) => await ctx.db.get(inboundMessageId));
		expect(inbound!.processingStatus).toBe('failed');
		expect(inbound!.errorMessage).toBe('nope');
	});

	it('records a send that threw as failed', async () => {
		const { t, contactId, threadId } = await seed({ isConfigured: true });
		provider.send.mockRejectedValue(new Error('socket hang up'));
		await t.action(internal.channels.outbound.dispatchOutbound, {
			channel: 'generic',
			contactId,
			threadId,
			content: { text: 'Hello' },
		});

		const [row] = await outboundRows(t, threadId);
		expect(row).toMatchObject({ status: 'failed' });
		expect(JSON.parse(row!.metadata!)).toEqual({ error: 'socket hang up' });
	});

	it('without a thread still completes the approved reply, and records no row', async () => {
		const { t, contactId, inboundMessageId } = await seed({ isConfigured: true });
		provider.send.mockResolvedValue({ success: true, externalMessageId: 'ext-3' });
		await t.action(internal.channels.outbound.dispatchOutbound, {
			channel: 'generic',
			contactId,
			content: { text: 'Hello' },
			inboundMessageId,
		});

		const outbound = await t.run(async (ctx) =>
			(await ctx.db.query('unifiedMessages').collect()).filter(
				(row) => row.direction === 'outbound'
			)
		);
		expect(outbound).toHaveLength(0);
		const inbound = await t.run(async (ctx) => await ctx.db.get(inboundMessageId));
		expect(inbound!.processingStatus).toBe('sent');
	});
});

describe('channels.outbound.pollDeliveryStatus', () => {
	it('moves only the rows the provider reports past `sent`, and survives a provider error', async () => {
		const { t, contactId, threadId } = await seed({ isConfigured: true });
		const [delivered, read, queued, broken] = await t.run(async (ctx) => {
			const row = (externalMessageId: string) =>
				ctx.db.insert(
					'unifiedMessages',
					createTestUnifiedMessage({
						threadId,
						contactId,
						channel: 'generic',
						direction: 'outbound',
						status: 'sent',
						externalMessageId,
					})
				);
			return [await row('ext-d'), await row('ext-r'), await row('ext-q'), await row('ext-x')];
		});
		provider.getDeliveryStatus.mockImplementation(async (externalMessageId: string) => {
			if (externalMessageId === 'ext-x') throw new Error('provider down');
			return { 'ext-d': 'delivered', 'ext-r': 'read', 'ext-q': 'queued' }[externalMessageId];
		});

		await t.action(internal.channels.outbound.pollDeliveryStatus, {});

		const status = async (id: Id<'unifiedMessages'>) =>
			(await t.run(async (ctx) => await ctx.db.get(id)))!.status;
		expect(await status(delivered)).toBe('delivered');
		expect(await status(read)).toBe('read');
		expect(await status(queued)).toBe('sent');
		expect(await status(broken)).toBe('sent');
		expect(provider.getDeliveryStatus).toHaveBeenCalledTimes(4);
	});

	it('leaves every row at `sent` when the channel is not configured', async () => {
		const { t, contactId, threadId } = await seed({ isConfigured: false });
		const id = await t.run(async (ctx) =>
			ctx.db.insert(
				'unifiedMessages',
				createTestUnifiedMessage({
					threadId,
					contactId,
					channel: 'generic',
					direction: 'outbound',
					status: 'sent',
					externalMessageId: 'ext-1',
				})
			)
		);
		await t.action(internal.channels.outbound.pollDeliveryStatus, {});
		expect((await t.run(async (ctx) => await ctx.db.get(id)))!.status).toBe('sent');
		expect(provider.getDeliveryStatus).not.toHaveBeenCalled();
	});
});
