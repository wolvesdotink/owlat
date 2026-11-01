/**
 * The provider routing and channel message endpoints
 * (`delivery/providerRoutes`, `delivery/providerRouteRelays`,
 * `channels/messages`, `channels/config`, `channels/outboundTargets`,
 * `channels/health`): what each reads, writes and schedules, and the auth
 * floor each keeps. The clock is faked; scheduled work is read by the function
 * it targets and never run.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import * as runtimeLog from '../lib/runtimeLog';
import { openUnifiedMessageContent } from '../lib/messageBody';

const session = vi.hoisted(() => ({
	role: 'owner' as 'owner' | 'admin' | 'editor',
	isMember: true,
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
	const member = () => {
		if (!session.isMember) throw new Error('forbidden: not an org member');
		return { userId: 'test-user', role: session.role, activeOrganizationId: 'org-1' };
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => member()),
		getMutationContext: vi.fn(async () => member()),
		isActiveOrgMember: vi.fn(async () => session.isMember),
		// The relay identity drain resolves the singleton org, and nothing here
		// stands up BetterAuth to answer it.
		getSingletonOrganizationId: vi.fn(async () => 'org-1'),
	};
});

const modules = import.meta.glob('../**/*.*s');
const NOW = Date.UTC(2026, 9, 1, 12);

type T = TestConvex<typeof schema>;

beforeEach(() => {
	session.role = 'owner';
	session.isMember = true;
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'test-key');
	vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
	vi.spyOn(runtimeLog, 'logError').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

const mandrillRoute = {
	messageType: 'campaign' as const,
	strategy: 'single' as const,
	providers: [
		{ providerType: 'mta', isEnabled: true },
		{ providerType: 'mandrill', isEnabled: true },
	],
	deliverabilityFallback: {
		isEnabled: true,
		relayProviderType: 'mandrill',
		isWarmupOverflowEnabled: false,
	},
};

/** Verified own-MTA sending domains, `relay-0.example` onward. */
async function verifiedDomains(t: T, count: number) {
	await t.run(async (ctx) => {
		for (let index = 0; index < count; index++) {
			await ctx.db.insert('domains', {
				domain: `relay-${index}.example`,
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
	});
}

/** A contact with an SMS number, a thread with an email and an SMS message, and three channels. */
async function seedChannels(t: T) {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', {
			email: 'ada@example.com',
			firstName: 'Ada',
			lastName: 'Lovelace',
			source: 'api',
			language: 'en',
			searchableText: 'ada@example.com Ada Lovelace',
			doiStatus: 'not_required',
			createdAt: NOW,
			updatedAt: NOW,
		});
		await ctx.db.insert('contactIdentities', {
			contactId,
			channel: 'phone',
			identifier: '+15550001111',
			isPrimary: true,
			createdAt: NOW,
		});
		const threadId = await ctx.db.insert('conversationThreads', {
			subject: 'Order question',
			normalizedSubject: 'order question',
			contactId,
			contactIdentifier: 'ada@example.com',
			status: 'open',
			messageCount: 2,
			lastMessageAt: NOW,
			firstMessageAt: NOW,
			createdAt: NOW,
		});
		const message = {
			threadId,
			contactId,
			contentVersion: 1,
			contentStorageVersion: 0,
			createdAt: NOW,
		};
		await ctx.db.insert('unifiedMessages', {
			...message,
			channel: 'email',
			direction: 'inbound',
			content: JSON.stringify({ text: 'Where is my order?' }),
			status: 'received',
			metadata: JSON.stringify({ subject: 'Order question' }),
		});
		await ctx.db.insert('unifiedMessages', {
			...message,
			channel: 'sms',
			direction: 'outbound',
			content: JSON.stringify({ text: 'It ships today.' }),
			externalMessageId: 'SM123',
			status: 'sent',
			createdAt: NOW + 1,
		});
		for (const channel of ['email', 'sms', 'chat'] as const) {
			await ctx.db.insert('channelConfigs', {
				channel,
				isEnabled: true,
				displayName: channel,
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
		return { contactId, threadId };
	});
}

/**
 * The rows a write leaves behind, without creation times, with message bodies
 * opened, plus the function each scheduled job targets.
 */
async function written(t: T) {
	return await t.run(async (ctx) => ({
		providerRoutes: (await ctx.db.query('providerRoutes').collect()).map(
			({ _creationTime, ...rest }) => rest
		),
		unifiedMessages: await Promise.all(
			(await ctx.db.query('unifiedMessages').collect()).map(
				async ({ _creationTime, content, ...rest }) => ({
					...rest,
					content: await openUnifiedMessageContent(content),
				})
			)
		),
		conversationThreads: (await ctx.db.query('conversationThreads').collect()).map(
			({ _creationTime, ...rest }) => rest
		),
		channelConfigs: (await ctx.db.query('channelConfigs').collect()).map(
			({ _creationTime, ...rest }) => rest
		),
		scheduled: (await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name),
	}));
}

describe('provider routing endpoints', () => {
	it('setRoute saves the route and starts the relay drain; removeRoute resets it', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.delivery.providerRoutes.setRoute, mandrillRoute);
		const saved = await written(t);
		expect(saved.providerRoutes).toMatchObject([
			{ messageType: 'campaign', deliverabilityFallback: mandrillRoute.deliverabilityFallback },
		]);
		expect(saved.scheduled).toEqual([
			'delivery/providerRouteRelays:provisionDeliverabilityRelayBatch',
		]);

		expect(
			await t.mutation(api.delivery.providerRoutes.removeRoute, { messageType: 'campaign' })
		).toEqual({ success: true });
		expect((await written(t)).providerRoutes).toEqual([]);
	});

	it('the reads answer the routes, the pools, the transport catalog and the relay identities', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.delivery.providerRoutes.setRoute, mandrillRoute);
		await verifiedDomains(t, 1);

		expect(await t.query(api.delivery.providerRoutes.listRoutes, {})).toHaveLength(1);
		expect((await t.query(api.delivery.providerRoutes.listIpPools, {})).length).toBeGreaterThan(0);
		expect(await t.query(api.delivery.providerRoutes.listTransportCatalog, {})).toContainEqual(
			expect.objectContaining({ kind: 'mandrill', isAvailable: true })
		);

		const page = { paginationOpts: { numItems: 10, cursor: null } };
		const relays = await t.query(api.delivery.providerRouteRelays.listRelayDomainIdentities, page);
		expect(relays.page).toMatchObject([
			{ domain: 'relay-0.example', kind: 'mandrill', status: 'provisioning' },
		]);
	});

	it('provisionDeliverabilityRelayBatch drains a page and queues the rest', async () => {
		const t = convexTest(schema, modules);
		await verifiedDomains(t, 3);

		await t.mutation(internal.delivery.providerRouteRelays.provisionDeliverabilityRelayBatch, {
			relayProviderType: 'mandrill',
			paginationOpts: { cursor: null, numItems: 2 },
		});
		// A Mandrill registration for each of the first page's two domains, and
		// the rest of the drain queued.
		expect((await written(t)).scheduled).toEqual([
			'domains/mandrillRelay:provision',
			'domains/mandrillRelay:provision',
			'delivery/providerRouteRelays:provisionDeliverabilityRelayBatch',
		]);
	});

	it('keep the organization:manage floor and the member read floor', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.delivery.providerRoutes.setRoute, mandrillRoute);

		session.role = 'editor';
		await expect(t.query(api.delivery.providerRoutes.listRoutes, {})).rejects.toThrow(
			'Only owners and admins can view provider routing'
		);
		await expect(t.mutation(api.delivery.providerRoutes.setRoute, mandrillRoute)).rejects.toThrow(
			'Only owners and admins can change provider routing'
		);
		await expect(
			t.mutation(api.delivery.providerRoutes.removeRoute, { messageType: 'campaign' })
		).rejects.toThrow('Only owners and admins can change provider routing');
		await expect(
			t.query(api.delivery.providerRouteRelays.listRelayDomainIdentities, {
				paginationOpts: { numItems: 10, cursor: null },
			})
		).rejects.toThrow();
		// An editor still reads the static pool names and the transport catalog.
		expect((await t.query(api.delivery.providerRoutes.listIpPools, {})).length).toBeGreaterThan(0);
		expect(
			(await t.query(api.delivery.providerRoutes.listTransportCatalog, {})).length
		).toBeGreaterThan(0);

		session.isMember = false;
		await expect(t.query(api.delivery.providerRoutes.listIpPools, {})).rejects.toThrow(
			/not an org member/
		);
		// The refused writes changed nothing.
		session.isMember = true;
		session.role = 'owner';
		expect((await written(t)).providerRoutes).toMatchObject([{ messageType: 'campaign' }]);
	});
});

describe('channel message endpoints', () => {
	it('the timeline reads answer shared-inbox readers only', async () => {
		const t = convexTest(schema, modules);
		const { contactId, threadId } = await seedChannels(t);

		const thread = await t.query(api.channels.messages.getThreadTimeline, { threadId });
		expect(thread.map((row) => row.content)).toEqual([
			{ text: 'Where is my order?' },
			{ text: 'It ships today.' },
		]);
		expect(thread[0]?.metadata).toEqual({ subject: 'Order question' });

		expect(await t.query(api.channels.messages.getContactTimeline, { contactId })).toHaveLength(2);

		for (const args of [{}, { channel: 'sms' as const }]) {
			expect((await t.query(api.channels.messages.listRecent, args)).length).toBeGreaterThan(0);
		}

		session.role = 'editor';
		const notAReader = /Team Inbox/;
		await expect(t.query(api.channels.messages.getThreadTimeline, { threadId })).rejects.toThrow(
			notAReader
		);
		await expect(t.query(api.channels.messages.getContactTimeline, { contactId })).rejects.toThrow(
			notAReader
		);
		await expect(t.query(api.channels.messages.listRecent, {})).rejects.toThrow(notAReader);
		await expect(
			t.mutation(api.channels.messages.sendChatMessage, { threadId, text: 'hi' })
		).rejects.toThrow(notAReader);
	});

	it('sendChatMessage stores a delivered chat message and stamps the channel', async () => {
		const t = convexTest(schema, modules);
		const { contactId, threadId } = await seedChannels(t);

		await t.mutation(api.channels.messages.sendChatMessage, {
			threadId,
			contactId,
			text: 'Anything else?',
		});
		const sent = await written(t);
		const last = sent.unifiedMessages[sent.unifiedMessages.length - 1];
		expect(last).toMatchObject({
			channel: 'chat',
			direction: 'outbound',
			status: 'delivered',
			content: { text: 'Anything else?' },
		});
		expect(last?.externalMessageId).toMatch(/^chat_/);
		expect(sent.channelConfigs.find((row) => row.channel === 'chat')).toMatchObject({
			lastSuccessfulSend: NOW,
		});
	});

	it('listPendingDeliveryStatus answers the outbound messages awaiting a delivery status', async () => {
		const t = convexTest(schema, modules);
		await seedChannels(t);
		const args = { sinceMs: 24 * 3600_000, limit: 10 };

		expect(await t.query(internal.channels.messages.listPendingDeliveryStatus, args)).toMatchObject(
			[{ channel: 'sms', externalMessageId: 'SM123' }]
		);
	});
});

describe('channel configuration endpoints', () => {
	it('updateChannelConfig saves the row and schedules the secret; setChannelConfigSecret stores it', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.channels.config.updateChannelConfig, {
			channel: 'whatsapp',
			isEnabled: true,
			displayName: 'WhatsApp',
			config: '{"phoneNumberId":"123"}',
		});
		const saved = await written(t);
		expect(saved.channelConfigs).toMatchObject([{ channel: 'whatsapp', isEnabled: true }]);
		// The plaintext config never lands on the row; it is encrypted by the job.
		expect(saved.channelConfigs[0]?.config).toBeUndefined();
		expect(saved.scheduled).toEqual(['channels/outbound:encryptAndPersistConfig']);

		await t.mutation(internal.channels.config.setChannelConfigSecret, {
			channel: 'whatsapp',
			config: 'envelope',
			configuredFields: ['phoneNumberId'],
		});
		expect((await written(t)).channelConfigs).toMatchObject([
			{ config: 'envelope', configuredFields: ['phoneNumberId'] },
		]);
	});

	it('the config reads hide the secret, and its field list from members', async () => {
		const t = convexTest(schema, modules);
		await seedChannels(t);
		await t.mutation(internal.channels.config.setChannelConfigSecret, {
			channel: 'sms',
			config: 'envelope',
			configuredFields: ['accountSid'],
		});

		const asAdmin = await t.query(api.channels.config.getChannelConfigs, {});
		const smsRow = asAdmin.find((row) => row.channel === 'sms');
		expect(smsRow).toMatchObject({ configuredFields: ['accountSid'] });
		expect(smsRow).not.toHaveProperty('config');

		session.role = 'editor';
		const asMember = await t.query(api.channels.config.getChannelConfigs, {});
		expect(asMember.find((row) => row.channel === 'sms')?.configuredFields).toBeUndefined();
		await expect(
			t.mutation(api.channels.config.updateChannelConfig, { channel: 'sms', isEnabled: false })
		).rejects.toThrow('Only owners and admins can configure channels');

		expect(
			await t.query(internal.channels.config.getChannelConfigInternal, { channel: 'sms' })
		).toMatchObject({ channel: 'sms', config: 'envelope' });

		const enabled = await t.query(internal.channels.health.getEnabledChannels, {});
		expect(enabled.map((row) => row.channel).sort()).toEqual(['chat', 'email', 'sms']);
	});
});

describe('outbound targets and channel health', () => {
	it('resolve the contact identifier and the thread an outbound message continues or opens', async () => {
		const t = convexTest(schema, modules);
		const { contactId, threadId } = await seedChannels(t);

		expect(
			await t.query(internal.channels.outboundTargets.getContactChannelIdentifier, {
				contactId,
				channel: 'sms',
			})
		).toBe('+15550001111');

		// The contact's latest SMS thread is continued; a pinned thread is checked
		// and returned.
		for (const pin of [{}, { threadId }]) {
			expect(
				await t.mutation(internal.channels.outboundTargets.resolveOutboundThread, {
					contactId,
					channel: 'sms',
					...pin,
				})
			).toBe(threadId);
		}

		// No WhatsApp message yet, so a fresh thread opens.
		await t.run(async (ctx) => {
			await ctx.db.insert('channelConfigs', {
				channel: 'whatsapp',
				isEnabled: true,
				createdAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('contactIdentities', {
				contactId,
				channel: 'whatsapp',
				identifier: '+15550001111',
				isPrimary: false,
				createdAt: NOW,
			});
		});
		const fresh = await t.mutation(internal.channels.outboundTargets.resolveOutboundThread, {
			contactId,
			channel: 'whatsapp',
		});
		expect(fresh).not.toBe(threadId);
		const opened = await written(t);
		expect(opened.conversationThreads[opened.conversationThreads.length - 1]).toMatchObject({
			_id: fresh,
			subject: 'Conversation with Ada Lovelace',
			status: 'open',
		});
	});

	it("runChannelHealthChecks and updateChannelHealth record each channel's health", async () => {
		const t = convexTest(schema, modules);
		await seedChannels(t);

		// Email and chat are healthy by config presence; SMS has no credentials.
		await t.action(internal.channels.health.runChannelHealthChecks, {});
		const checked = await written(t);
		expect(
			checked.channelConfigs.map((row) => [row.channel, row.healthStatus, row.lastError])
		).toEqual([
			['email', 'healthy', undefined],
			['sms', 'down', 'No credentials configured'],
			['chat', 'healthy', undefined],
		]);

		await t.mutation(internal.channels.health.updateChannelHealth, {
			channel: 'sms',
			healthStatus: 'degraded',
			lastError: '429',
		});
		const probed = await written(t);
		expect(probed.channelConfigs.find((row) => row.channel === 'sms')).toMatchObject({
			healthStatus: 'degraded',
			lastError: '429',
			lastHealthCheckAt: NOW,
		});
	});
});
