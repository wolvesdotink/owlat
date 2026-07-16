import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.postmark',
			pluginId: 'mail-pack',
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze(['POSTMARK_TOKEN']),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../../plugins/plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/mail-pack',
			manifest: Object.freeze({
				id: 'mail-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:transport']),
				flag: Object.freeze({
					default: false,
					requiredEnvVars: Object.freeze(['POSTMARK_TOKEN']),
				}),
			}),
		}),
	]),
}));

vi.mock('../../../delivery/workpool', () => ({
	transactionalEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
	campaignEmailPool: {
		enqueueAction: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	return {
		...actual,
		getSingletonOrganizationId: vi.fn(async () => 'organization-id'),
		requireOrgMember: vi.fn(async () => ({ userId: 'test-user', role: 'owner' })),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => 'test-user'),
		getMutationContext: vi.fn(async () => ({ userId: 'test-user', role: 'owner' })),
		requireOrgPermission: vi.fn(async () => ({ userId: 'test-user', role: 'owner' })),
	};
});

import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestEmailTemplate,
} from '../../../__tests__/factories';
import { _resetSingletonOrgCacheForTests } from '../../../lib/sessionOrganization';
import { deliveryConfiguredFromEnv, isDeliveryConfigured } from '../capability';
import { resolveSendRouteFromDb, type MessageType } from '../route';

const pluginKind = 'plugin.mail-pack.postmark';
const pluginFlag = 'plugin.mail-pack';
const modules = import.meta.glob('../../../**/*.*s');

interface ReadinessFixture {
	readonly isEnabled?: boolean;
	readonly isGranted?: boolean;
}

function fakeContext({ isEnabled = true, isGranted = true }: ReadinessFixture = {}) {
	const settings = {
		featureFlags: { [pluginFlag]: isEnabled },
		pluginCapabilityGrants: { [pluginFlag]: { 'send:transport': isGranted } },
	};
	return {
		runQuery: vi.fn(async () => ({ page: [{ id: 'organization-id' }] })),
		db: {
			query: vi.fn((table: string) => {
				if (table === 'instanceSettings') {
					return { first: vi.fn(async () => settings) };
				}
				if (table === 'providerRoutes') {
					return {
						collect: vi.fn(async () => []),
						withIndex: vi.fn(() => ({ first: vi.fn(async () => null) })),
					};
				}
				if (table === 'providerHealth') {
					return { collect: vi.fn(async () => []) };
				}
				throw new TypeError(`Unexpected table: ${table}`);
			}),
		},
	};
}

async function expectFallbackReadiness(
	messageType: MessageType,
	fixture: ReadinessFixture,
	expectedReady: boolean
): Promise<void> {
	_resetSingletonOrgCacheForTests();
	const ctx = fakeContext(fixture);
	expect(await isDeliveryConfigured(ctx as never, messageType)).toBe(expectedReady);
	expect(await resolveSendRouteFromDb(ctx as never, messageType)).toEqual(
		expectedReady ? { providerType: pluginKind, source: 'env_fallback' } : null
	);
}

describe('composed plugin EMAIL_PROVIDER readiness', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		vi.unstubAllEnvs();
		vi.stubEnv('EMAIL_PROVIDER', pluginKind);
		vi.stubEnv('POSTMARK_TOKEN', 'present');
	});

	it.each(['campaign', 'transactional'] as const)(
		'uses the same ready plugin fallback for the %s gate and route resolution',
		async (messageType) => {
			await expectFallbackReadiness(messageType, {}, true);
		}
	);

	it.each([
		['disabled flag', { isEnabled: false }],
		['missing grant', { isGranted: false }],
	] as const)('rejects a plugin fallback with a %s', async (_label, fixture) => {
		await expectFallbackReadiness('campaign', fixture, false);
		await expectFallbackReadiness('transactional', fixture, false);
	});

	it('rejects plugin fallback when its required environment is absent', async () => {
		vi.stubEnv('POSTMARK_TOKEN', '');
		await expectFallbackReadiness('campaign', {}, false);
		await expectFallbackReadiness('transactional', {}, false);
	});

	it('rejects a stale plugin kind that is no longer in the composed catalog', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'plugin.retired-mail.postmark');
		const ctx = fakeContext();
		expect(await deliveryConfiguredFromEnv(ctx as never)).toBe(false);
		expect(await isDeliveryConfigured(ctx as never, 'campaign')).toBe(false);
		expect(await resolveSendRouteFromDb(ctx as never, 'transactional')).toBeNull();
	});
});

async function seedPluginReadinessScenario(fixture: ReadinessFixture) {
	const t = convexTest(schema, modules);
	let campaignId: Id<'campaigns'> | undefined;
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { [pluginFlag]: fixture.isEnabled ?? true },
			pluginCapabilityGrants: {
				[pluginFlag]: { 'send:transport': fixture.isGranted ?? true },
			},
			createdAt: 0,
			updatedAt: 0,
		});
		const emailTemplateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		const topicId = await ctx.db.insert('topics', {
			name: 'General',
			description: '',
			isDefault: false,
			createdAt: 0,
		});
		campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'draft',
				emailTemplateId,
				fromEmail: 'sender@unverified.example.com',
				audience: { kind: 'topic', topicId },
			})
		);
	});
	return { t, campaignId: campaignId! };
}

async function expectEntryPointReadiness(
	fixture: ReadinessFixture,
	expectedReady: boolean
): Promise<void> {
	const { t, campaignId } = await seedPluginReadinessScenario(fixture);
	const campaign = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
		campaignId,
	});
	expect(campaign).toMatchObject({
		ok: false,
		reason: expectedReady ? 'domain_not_verified' : 'no_delivery_provider',
	});

	const transactional = await t.mutation(internal.transactional.dispatch.dispatch, {
		templateLookup: { kind: 'slug', slug: 'missing-template' },
		email: 'recipient@example.com',
	});
	expect(transactional).toMatchObject({
		ok: false,
		reason: expectedReady ? 'template_not_found' : 'no_delivery_provider',
	});
}

describe('campaign and transactional plugin readiness gates', () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.stubEnv('EMAIL_PROVIDER', pluginKind);
		vi.stubEnv('POSTMARK_TOKEN', 'present');
	});

	it('allows a ready plugin past both delivery gates', async () => {
		await expectEntryPointReadiness({}, true);
	});

	it.each([
		['disabled flag', { isEnabled: false }],
		['missing grant', { isGranted: false }],
	] as const)('rejects both delivery paths for a plugin with a %s', async (_label, fixture) => {
		await expectEntryPointReadiness(fixture, false);
	});

	it('rejects both delivery paths when plugin environment is missing', async () => {
		vi.stubEnv('POSTMARK_TOKEN', '');
		await expectEntryPointReadiness({}, false);
	});

	it('rejects both delivery paths for a stale plugin kind', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'plugin.retired-mail.postmark');
		await expectEntryPointReadiness({}, false);
	});
});

async function expectNonCampaignEnqueueRejected(
	fixture: ReadinessFixture,
	providerType: string
): Promise<void> {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { [pluginFlag]: fixture.isEnabled ?? true },
			pluginCapabilityGrants: {
				[pluginFlag]: { 'send:transport': fixture.isGranted ?? true },
			},
			createdAt: 0,
			updatedAt: 0,
		});
	});

	await expect(
		t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'automation',
			email: 'recipient@example.com',
			subject: 'Hello',
			html: '<p>Hello</p>',
			from: 'Owlat <sender@example.com>',
			providerType,
		})
	).rejects.toThrow('no_delivery_provider');

	const sends = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
	expect(sends).toHaveLength(0);
}

describe('enqueue provider selection matches worker selection', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		vi.unstubAllEnvs();
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		vi.stubEnv('MTA_API_URL', 'http://mta:3100');
		vi.stubEnv('MTA_API_KEY', 'mta-key');
		vi.stubEnv('POSTMARK_TOKEN', 'present');
	});

	it.each([
		['disabled flag', { isEnabled: false }],
		['missing grant', { isGranted: false }],
	] as const)(
		'rejects an explicit plugin with a %s instead of borrowing a ready env provider',
		async (_label, fixture) => {
			await expectNonCampaignEnqueueRejected(fixture, pluginKind);
		}
	);

	it('rejects an explicit plugin with missing environment instead of borrowing a ready env provider', async () => {
		vi.stubEnv('POSTMARK_TOKEN', '');
		await expectNonCampaignEnqueueRejected({}, pluginKind);
	});

	it('rejects an invalid explicit provider instead of borrowing a ready env provider', async () => {
		await expectNonCampaignEnqueueRejected({}, 'plugin.retired-mail.postmark');
	});

	it('rejects an unconfigured explicit core provider instead of borrowing a ready env provider', async () => {
		vi.stubEnv('RESEND_API_KEY', '');
		await expectNonCampaignEnqueueRejected({}, 'resend');
	});

	it('uses the ready environment provider only when no explicit provider is supplied', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.mutation(internal.delivery.enqueue.enqueueNonCampaignSend, {
			kind: 'automation',
			email: 'recipient@example.com',
			subject: 'Hello',
			html: '<p>Hello</p>',
			from: 'Owlat <sender@example.com>',
		});

		const send = await t.run(async (ctx) => ctx.db.get(sendId));
		expect(send).toMatchObject({ status: 'queued', email: 'recipient@example.com' });
		expect(send?.providerType).toBeUndefined();
	});

	it('rechecks an explicit campaign plugin before queueing delayed recipients', async () => {
		const { t, campaignId } = await seedPluginReadinessScenario({ isEnabled: false });
		const { contactId, emailSendId } = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'recipient@example.com' })
			);
			const emailSendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, contactEmail: 'recipient@example.com' })
			);
			return { contactId, emailSendId };
		});
		const { campaignEmailPool } = await import('../../../delivery/workpool');
		const enqueueAction = vi.mocked(campaignEmailPool.enqueueAction);
		enqueueAction.mockClear();

		await expect(
			t.mutation(internal.delivery.enqueue.enqueueCampaignEmails, {
				campaignId,
				emails: [{ emailSendId, contactId, email: 'recipient@example.com' }],
				from: 'Owlat <sender@example.com>',
				subject: 'Hello',
				htmlContent: '<p>Hello</p>',
				providerType: pluginKind,
			})
		).rejects.toThrow('no_delivery_provider');
		expect(enqueueAction).not.toHaveBeenCalled();
	});
});
