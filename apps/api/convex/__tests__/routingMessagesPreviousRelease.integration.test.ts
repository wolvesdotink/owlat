/**
 * The previous release's provider routing and unified message paths
 * (`providerRoutes:*`, `unifiedMessages:*`) keep working against this release:
 * each old path takes the same arguments, declares the same result, keeps its
 * auth floor, and reads and writes what its moved function in
 * `delivery/providerRoutes`, `delivery/providerRouteRelays`,
 * `channels/messages`, `channels/config`, `channels/outboundTargets` or
 * `channels/health` does.
 *
 * Writes are compared across two fresh deployments seeded alike, one driven
 * through the old path and one through the new, with the clock faked so both
 * stamp the same times. Scheduled work is compared by the function it targets
 * and never run.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import * as runtimeLog from '../lib/runtimeLog';
import { openUnifiedMessageContent } from '../lib/messageBody';
import * as oldProviderRoutes from '../providerRoutes';
import * as oldUnifiedMessages from '../unifiedMessages';
import * as providerRoutes from '../delivery/providerRoutes';
import * as providerRouteRelays from '../delivery/providerRouteRelays';
import * as messages from '../channels/messages';
import * as config from '../channels/config';
import * as outboundTargets from '../channels/outboundTargets';
import * as health from '../channels/health';

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

describe('previous-release routing and message paths: shapes', () => {
	it('keep the builder kind, visibility, arguments and result of the moved functions', () => {
		const shape = (fn: unknown) => {
			const registered = fn as {
				isQuery?: boolean;
				isMutation?: boolean;
				isAction?: boolean;
				isPublic?: boolean;
				isInternal?: boolean;
				exportArgs(): string;
				exportReturns(): string;
			};
			return {
				kind: [registered.isQuery, registered.isMutation, registered.isAction],
				visibility: [registered.isPublic, registered.isInternal],
				args: registered.exportArgs(),
				returns: registered.exportReturns(),
			};
		};
		const pairs: [unknown, unknown][] = [
			[oldProviderRoutes.listRoutes, providerRoutes.listRoutes],
			[oldProviderRoutes.listIpPools, providerRoutes.listIpPools],
			[oldProviderRoutes.listTransportCatalog, providerRoutes.listTransportCatalog],
			[oldProviderRoutes.setRoute, providerRoutes.setRoute],
			[oldProviderRoutes.removeRoute, providerRoutes.removeRoute],
			[oldProviderRoutes.listRelayDomainIdentities, providerRouteRelays.listRelayDomainIdentities],
			[
				oldProviderRoutes.provisionDeliverabilityRelayBatch,
				providerRouteRelays.provisionDeliverabilityRelayBatch,
			],
			[oldUnifiedMessages.getThreadTimeline, messages.getThreadTimeline],
			[oldUnifiedMessages.getContactTimeline, messages.getContactTimeline],
			[oldUnifiedMessages.listRecent, messages.listRecent],
			[oldUnifiedMessages.sendChatMessage, messages.sendChatMessage],
			[oldUnifiedMessages.listPendingDeliveryStatus, messages.listPendingDeliveryStatus],
			[oldUnifiedMessages.getChannelConfigs, config.getChannelConfigs],
			[oldUnifiedMessages.updateChannelConfig, config.updateChannelConfig],
			[oldUnifiedMessages.setChannelConfigSecret, config.setChannelConfigSecret],
			[oldUnifiedMessages.getChannelConfigInternal, config.getChannelConfigInternal],
			[oldUnifiedMessages.getContactChannelIdentifier, outboundTargets.getContactChannelIdentifier],
			[oldUnifiedMessages.resolveOutboundThread, outboundTargets.resolveOutboundThread],
			[oldUnifiedMessages.updateChannelHealth, health.updateChannelHealth],
			[oldUnifiedMessages.runChannelHealthChecks, health.runChannelHealthChecks],
			[oldUnifiedMessages.getEnabledChannels, health.getEnabledChannels],
		];
		expect(pairs).toHaveLength(21);
		for (const [old, moved] of pairs) expect(shape(old)).toEqual(shape(moved));
		// Every root export is one of the pairs above, or one of the two wrappers
		// the release before kept: no old path was dropped.
		expect(Object.keys(oldProviderRoutes).sort()).toEqual(
			[
				'listIpPools',
				'listRelayDomainIdentities',
				'listRoutes',
				'listTransportCatalog',
				'provisionDeliverabilityRelayBatch',
				'removeRoute',
				'setRoute',
			].sort()
		);
		expect(Object.keys(oldUnifiedMessages).sort()).toEqual(
			[
				'getChannelConfigInternal',
				'getChannelConfigs',
				'getContactChannelIdentifier',
				'getContactTimeline',
				'getEnabledChannels',
				'getThreadTimeline',
				'listPendingDeliveryStatus',
				'listRecent',
				'recordOutbound',
				'resolveOutboundThread',
				'runChannelHealthChecks',
				'sendChatMessage',
				'setChannelConfigSecret',
				'updateChannelConfig',
				'updateChannelHealth',
				'updateDeliveryStatus',
			].sort()
		);
	});
});

describe('previous-release provider routing paths', () => {
	it('providerRoutes:setRoute and removeRoute write and schedule what delivery/providerRoutes does', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);

		const oldId = await old.mutation(api.providerRoutes.setRoute, mandrillRoute);
		const newId = await moved.mutation(api.delivery.providerRoutes.setRoute, mandrillRoute);
		expect(oldId).toEqual(newId);
		const saved = await written(old);
		expect(saved).toEqual(await written(moved));
		expect(saved.providerRoutes).toMatchObject([
			{ messageType: 'campaign', deliverabilityFallback: mandrillRoute.deliverabilityFallback },
		]);
		// The old path starts the drain this release runs, not a root path.
		expect(saved.scheduled).toEqual([
			'delivery/providerRouteRelays:provisionDeliverabilityRelayBatch',
		]);

		const oldReset = await old.mutation(api.providerRoutes.removeRoute, {
			messageType: 'campaign',
		});
		const newReset = await moved.mutation(api.delivery.providerRoutes.removeRoute, {
			messageType: 'campaign',
		});
		expect(oldReset).toEqual({ success: true });
		expect(newReset).toEqual(oldReset);
		const removed = await written(old);
		expect(removed).toEqual(await written(moved));
		expect(removed.providerRoutes).toEqual([]);
	});

	it('the old provider routing reads answer what delivery/providerRoutes and providerRouteRelays answer', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.delivery.providerRoutes.setRoute, mandrillRoute);
		await verifiedDomains(t, 1);

		const routes = await t.query(api.providerRoutes.listRoutes, {});
		expect(routes).toHaveLength(1);
		expect(routes).toEqual(await t.query(api.delivery.providerRoutes.listRoutes, {}));

		const pools = await t.query(api.providerRoutes.listIpPools, {});
		expect(pools.length).toBeGreaterThan(0);
		expect(pools).toEqual(await t.query(api.delivery.providerRoutes.listIpPools, {}));

		const catalog = await t.query(api.providerRoutes.listTransportCatalog, {});
		expect(catalog).toContainEqual(
			expect.objectContaining({ kind: 'mandrill', isAvailable: true })
		);
		expect(catalog).toEqual(await t.query(api.delivery.providerRoutes.listTransportCatalog, {}));

		const page = { paginationOpts: { numItems: 10, cursor: null } };
		const relays = await t.query(api.providerRoutes.listRelayDomainIdentities, page);
		expect(relays.page).toMatchObject([
			{ domain: 'relay-0.example', kind: 'mandrill', status: 'provisioning' },
		]);
		expect(relays).toEqual(
			await t.query(api.delivery.providerRouteRelays.listRelayDomainIdentities, page)
		);
	});

	it('providerRoutes:provisionDeliverabilityRelayBatch drains a page and continues at the new path', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);
		await verifiedDomains(old, 3);
		await verifiedDomains(moved, 3);
		const batch = { relayProviderType: 'mandrill', paginationOpts: { cursor: null, numItems: 2 } };

		await old.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, batch);
		await moved.mutation(
			internal.delivery.providerRouteRelays.provisionDeliverabilityRelayBatch,
			batch
		);
		const drained = await written(old);
		expect(drained).toEqual(await written(moved));
		// A Mandrill registration for each of the first page's two domains, and
		// the rest of the drain queued at the path this release runs.
		expect(drained.scheduled).toEqual([
			'domains/mandrillRelay:provision',
			'domains/mandrillRelay:provision',
			'delivery/providerRouteRelays:provisionDeliverabilityRelayBatch',
		]);
	});

	it('keep the organization:manage floor and the member read floor on the old paths', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.delivery.providerRoutes.setRoute, mandrillRoute);

		session.role = 'editor';
		await expect(t.query(api.providerRoutes.listRoutes, {})).rejects.toThrow(
			'Only owners and admins can view provider routing'
		);
		await expect(t.mutation(api.providerRoutes.setRoute, mandrillRoute)).rejects.toThrow(
			'Only owners and admins can change provider routing'
		);
		await expect(
			t.mutation(api.providerRoutes.removeRoute, { messageType: 'campaign' })
		).rejects.toThrow('Only owners and admins can change provider routing');
		await expect(
			t.query(api.providerRoutes.listRelayDomainIdentities, {
				paginationOpts: { numItems: 10, cursor: null },
			})
		).rejects.toThrow();
		// An editor still reads the static pool names and the transport catalog.
		expect(await t.query(api.providerRoutes.listIpPools, {})).toEqual(
			await t.query(api.delivery.providerRoutes.listIpPools, {})
		);
		expect((await t.query(api.providerRoutes.listTransportCatalog, {})).length).toBeGreaterThan(0);

		session.isMember = false;
		await expect(t.query(api.providerRoutes.listIpPools, {})).rejects.toThrow(/not an org member/);
		// The refused writes changed nothing.
		session.isMember = true;
		session.role = 'owner';
		expect((await written(t)).providerRoutes).toMatchObject([{ messageType: 'campaign' }]);
	});
});

describe('previous-release unified message paths', () => {
	it('the old timeline reads answer what channels/messages answers, for shared-inbox readers only', async () => {
		const t = convexTest(schema, modules);
		const { contactId, threadId } = await seedChannels(t);

		const thread = await t.query(api.unifiedMessages.getThreadTimeline, { threadId });
		expect(thread.map((row) => row.content)).toEqual([
			{ text: 'Where is my order?' },
			{ text: 'It ships today.' },
		]);
		expect(thread[0]?.metadata).toEqual({ subject: 'Order question' });
		expect(thread).toEqual(await t.query(api.channels.messages.getThreadTimeline, { threadId }));

		const contact = await t.query(api.unifiedMessages.getContactTimeline, { contactId });
		expect(contact).toHaveLength(2);
		expect(contact).toEqual(await t.query(api.channels.messages.getContactTimeline, { contactId }));

		for (const args of [{}, { channel: 'sms' as const }]) {
			const recent = await t.query(api.unifiedMessages.listRecent, args);
			expect(recent.length).toBeGreaterThan(0);
			expect(recent).toEqual(await t.query(api.channels.messages.listRecent, args));
		}

		session.role = 'editor';
		const notAReader = /Team Inbox/;
		await expect(t.query(api.unifiedMessages.getThreadTimeline, { threadId })).rejects.toThrow(
			notAReader
		);
		await expect(t.query(api.unifiedMessages.getContactTimeline, { contactId })).rejects.toThrow(
			notAReader
		);
		await expect(t.query(api.unifiedMessages.listRecent, {})).rejects.toThrow(notAReader);
		await expect(
			t.mutation(api.unifiedMessages.sendChatMessage, { threadId, text: 'hi' })
		).rejects.toThrow(notAReader);
	});

	it('unifiedMessages:sendChatMessage writes what channels/messages does', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);
		const oldSeed = await seedChannels(old);
		const newSeed = await seedChannels(moved);

		const oldId = await old.mutation(api.unifiedMessages.sendChatMessage, {
			threadId: oldSeed.threadId,
			contactId: oldSeed.contactId,
			text: 'Anything else?',
		});
		const newId = await moved.mutation(api.channels.messages.sendChatMessage, {
			threadId: newSeed.threadId,
			contactId: newSeed.contactId,
			text: 'Anything else?',
		});
		expect(oldId).toEqual(newId);
		// The chat id carries a random suffix; everything else matches.
		const withoutChatId = async (t: T) => {
			const rows = await written(t);
			return {
				...rows,
				unifiedMessages: rows.unifiedMessages.map(({ externalMessageId, ...rest }) => ({
					...rest,
					externalMessageId: externalMessageId?.startsWith('chat_') ? 'chat_' : externalMessageId,
				})),
			};
		};
		const sent = await withoutChatId(old);
		expect(sent).toEqual(await withoutChatId(moved));
		expect(sent.unifiedMessages[sent.unifiedMessages.length - 1]).toMatchObject({
			channel: 'chat',
			direction: 'outbound',
			status: 'delivered',
			content: { text: 'Anything else?' },
		});
		expect(sent.channelConfigs.find((row) => row.channel === 'chat')).toMatchObject({
			lastSuccessfulSend: NOW,
		});
	});

	it('unifiedMessages:listPendingDeliveryStatus answers what channels/messages answers', async () => {
		const t = convexTest(schema, modules);
		await seedChannels(t);
		const args = { sinceMs: 24 * 3600_000, limit: 10 };

		const pending = await t.query(internal.unifiedMessages.listPendingDeliveryStatus, args);
		expect(pending).toMatchObject([{ channel: 'sms', externalMessageId: 'SM123' }]);
		expect(pending).toEqual(
			await t.query(internal.channels.messages.listPendingDeliveryStatus, args)
		);
	});
});

describe('previous-release channel configuration paths', () => {
	it('unifiedMessages:updateChannelConfig and setChannelConfigSecret write what channels/config does', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);
		const save = {
			channel: 'whatsapp' as const,
			isEnabled: true,
			displayName: 'WhatsApp',
			config: '{"phoneNumberId":"123"}',
		};

		const oldId = await old.mutation(api.unifiedMessages.updateChannelConfig, save);
		const newId = await moved.mutation(api.channels.config.updateChannelConfig, save);
		expect(oldId).toEqual(newId);
		const saved = await written(old);
		expect(saved).toEqual(await written(moved));
		expect(saved.channelConfigs).toMatchObject([{ channel: 'whatsapp', isEnabled: true }]);
		expect(saved.channelConfigs[0]?.config).toBeUndefined();
		expect(saved.scheduled).toEqual(['channels/outbound:encryptAndPersistConfig']);

		const secret = {
			channel: 'whatsapp' as const,
			config: 'envelope',
			configuredFields: ['phoneNumberId'],
		};
		await old.mutation(internal.unifiedMessages.setChannelConfigSecret, secret);
		await moved.mutation(internal.channels.config.setChannelConfigSecret, secret);
		const stored = await written(old);
		expect(stored).toEqual(await written(moved));
		expect(stored.channelConfigs).toMatchObject([
			{ config: 'envelope', configuredFields: ['phoneNumberId'] },
		]);
	});

	it('the old channel config reads answer what channels/config and channels/health answer', async () => {
		const t = convexTest(schema, modules);
		await seedChannels(t);
		await t.mutation(internal.channels.config.setChannelConfigSecret, {
			channel: 'sms',
			config: 'envelope',
			configuredFields: ['accountSid'],
		});

		const asAdmin = await t.query(api.unifiedMessages.getChannelConfigs, {});
		const smsRow = asAdmin.find((row) => row.channel === 'sms');
		expect(smsRow).toMatchObject({ configuredFields: ['accountSid'] });
		expect(smsRow).not.toHaveProperty('config');
		expect(asAdmin).toEqual(await t.query(api.channels.config.getChannelConfigs, {}));

		session.role = 'editor';
		const asMember = await t.query(api.unifiedMessages.getChannelConfigs, {});
		expect(asMember.find((row) => row.channel === 'sms')?.configuredFields).toBeUndefined();
		expect(asMember).toEqual(await t.query(api.channels.config.getChannelConfigs, {}));
		await expect(
			t.mutation(api.unifiedMessages.updateChannelConfig, { channel: 'sms', isEnabled: false })
		).rejects.toThrow('Only owners and admins can configure channels');

		const internalRow = await t.query(internal.unifiedMessages.getChannelConfigInternal, {
			channel: 'sms',
		});
		expect(internalRow).toMatchObject({ channel: 'sms', config: 'envelope' });
		expect(internalRow).toEqual(
			await t.query(internal.channels.config.getChannelConfigInternal, { channel: 'sms' })
		);

		const enabled = await t.query(internal.unifiedMessages.getEnabledChannels, {});
		expect(enabled.map((row) => row.channel).sort()).toEqual(['chat', 'email', 'sms']);
		expect(enabled).toEqual(await t.query(internal.channels.health.getEnabledChannels, {}));
	});
});

describe('previous-release outbound dispatch and health paths', () => {
	it('unifiedMessages:getContactChannelIdentifier and resolveOutboundThread resolve what channels/outboundTargets does', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);
		const oldSeed = await seedChannels(old);
		const newSeed = await seedChannels(moved);

		const recipient = await old.query(internal.unifiedMessages.getContactChannelIdentifier, {
			contactId: oldSeed.contactId,
			channel: 'sms',
		});
		expect(recipient).toBe('+15550001111');
		expect(recipient).toEqual(
			await moved.query(internal.channels.outboundTargets.getContactChannelIdentifier, {
				contactId: newSeed.contactId,
				channel: 'sms',
			})
		);

		// The contact's latest SMS thread is continued; a pinned thread is checked
		// and returned.
		for (const pin of [{}, { threadId: oldSeed.threadId }]) {
			const oldThread = await old.mutation(internal.unifiedMessages.resolveOutboundThread, {
				contactId: oldSeed.contactId,
				channel: 'sms',
				...pin,
			});
			const newThread = await moved.mutation(
				internal.channels.outboundTargets.resolveOutboundThread,
				{ contactId: newSeed.contactId, channel: 'sms', ...pin }
			);
			expect(oldThread).toBe(oldSeed.threadId);
			expect(newThread).toBe(oldThread);
		}

		// No WhatsApp message yet, so both open the same fresh thread.
		const addWhatsApp = async (t: T, contactId: Id<'contacts'>) =>
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
		await addWhatsApp(old, oldSeed.contactId);
		await addWhatsApp(moved, newSeed.contactId);
		const oldFresh = await old.mutation(internal.unifiedMessages.resolveOutboundThread, {
			contactId: oldSeed.contactId,
			channel: 'whatsapp',
		});
		const newFresh = await moved.mutation(internal.channels.outboundTargets.resolveOutboundThread, {
			contactId: newSeed.contactId,
			channel: 'whatsapp',
		});
		expect(oldFresh).not.toBe(oldSeed.threadId);
		expect(newFresh).toBe(oldFresh);
		const opened = await written(old);
		expect(opened).toEqual(await written(moved));
		expect(opened.conversationThreads[opened.conversationThreads.length - 1]).toMatchObject({
			_id: oldFresh,
			subject: 'Conversation with Ada Lovelace',
			status: 'open',
		});
	});

	it('unifiedMessages:runChannelHealthChecks and updateChannelHealth record what channels/health does', async () => {
		const old = convexTest(schema, modules);
		const moved = convexTest(schema, modules);
		await seedChannels(old);
		await seedChannels(moved);

		// Email and chat are healthy by config presence; SMS has no credentials.
		await old.action(internal.unifiedMessages.runChannelHealthChecks, {});
		await moved.action(internal.channels.health.runChannelHealthChecks, {});
		const checked = await written(old);
		expect(checked).toEqual(await written(moved));
		expect(
			checked.channelConfigs.map((row) => [row.channel, row.healthStatus, row.lastError])
		).toEqual([
			['email', 'healthy', undefined],
			['sms', 'down', 'No credentials configured'],
			['chat', 'healthy', undefined],
		]);

		const probe = { channel: 'sms' as const, healthStatus: 'degraded' as const, lastError: '429' };
		await old.mutation(internal.unifiedMessages.updateChannelHealth, probe);
		await moved.mutation(internal.channels.health.updateChannelHealth, probe);
		const probed = await written(old);
		expect(probed).toEqual(await written(moved));
		expect(probed.channelConfigs.find((row) => row.channel === 'sms')).toMatchObject({
			healthStatus: 'degraded',
			lastError: '429',
			lastHealthCheckAt: NOW,
		});
	});
});
