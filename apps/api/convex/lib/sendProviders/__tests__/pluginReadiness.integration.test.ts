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
		expectedReady
			? { providerType: pluginKind, source: 'env_fallback', warmupOverflowEnabled: false }
			: null
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

/**
 * Seed an `automation` route table that names ONE provider kind, plus the
 * plugin flag/grant fixture that decides whether that kind is ready.
 *
 * The non-campaign intake no longer takes a `providerType` argument — its
 * producers used to resolve an advisory route in their own action and hand the
 * answer down, and PIECE C2 moved that resolution into the intake transaction.
 * So the way to put an unready provider in front of the intake is to put it on
 * the route table the intake itself resolves against, which is also the table
 * the worker's last-mile re-resolution reads. The claim under test is
 * unchanged: an unready kind must never carry a send.
 */
async function seedRoutedProvider(
	fixture: ReadinessFixture,
	providerType: string
): Promise<ReturnType<typeof convexTest>> {
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
		await ctx.db.insert('providerRoutes', {
			messageType: 'automation' as const,
			strategy: 'single' as const,
			providers: [{ providerType, isEnabled: true }],
			createdAt: 0,
			updatedAt: 0,
		});
	});
	return t;
}

function intakeAutomation(t: ReturnType<typeof convexTest>) {
	return t.mutation(internal.delivery.nonCampaignIntake.intake, {
		kind: 'automation' as const,
		email: 'recipient@example.com',
		subject: 'Hello',
		html: '<p>Hello</p>',
		from: 'Owlat <sender@example.com>',
	});
}

/** With the routed kind unready AND no env fallback, the intake must refuse. */
async function expectNonCampaignIntakeRejected(
	fixture: ReadinessFixture,
	providerType: string
): Promise<void> {
	const t = await seedRoutedProvider(fixture, providerType);
	vi.stubEnv('EMAIL_PROVIDER', '');
	vi.stubEnv('MTA_API_URL', '');
	vi.stubEnv('MTA_API_KEY', '');

	expect(await intakeAutomation(t)).toEqual({
		ok: false,
		reason: 'no_delivery_provider',
		detail: expect.stringContaining('EMAIL_PROVIDER'),
	});

	const sends = await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
	expect(sends).toHaveLength(0);
}

/**
 * With the routed kind unready but the ENV provider ready, the intake falls
 * back exactly as `resolveRoute` does — and stamps the env kind, never the
 * unready one. This is the positive half of "enqueue selection matches worker
 * selection": both sides run the same resolver over the same table.
 */
async function expectNonCampaignIntakeFallsBackToEnv(
	fixture: ReadinessFixture,
	providerType: string
): Promise<void> {
	const t = await seedRoutedProvider(fixture, providerType);

	const outcome = await intakeAutomation(t);
	expect(outcome.ok).toBe(true);
	if (!outcome.ok) return;
	const send = await t.run(async (ctx) => ctx.db.get(outcome.sendId));
	expect(send?.providerType).toBe('mta');
	expect(send?.providerType).not.toBe(providerType);
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
		'refuses a routed plugin with a %s when nothing else can deliver',
		async (_label, fixture) => {
			await expectNonCampaignIntakeRejected(fixture, pluginKind);
		}
	);

	it.each([
		['disabled flag', { isEnabled: false }],
		['missing grant', { isGranted: false }],
	] as const)(
		'never stamps a routed plugin with a %s — it falls back to the ready env provider',
		async (_label, fixture) => {
			await expectNonCampaignIntakeFallsBackToEnv(fixture, pluginKind);
		}
	);

	it('refuses a routed plugin with missing environment when nothing else can deliver', async () => {
		vi.stubEnv('POSTMARK_TOKEN', '');
		await expectNonCampaignIntakeRejected({}, pluginKind);
	});

	it('refuses an unknown routed provider when nothing else can deliver', async () => {
		await expectNonCampaignIntakeRejected({}, 'plugin.retired-mail.postmark');
	});

	it('refuses an unconfigured routed core provider when nothing else can deliver', async () => {
		vi.stubEnv('RESEND_API_KEY', '');
		await expectNonCampaignIntakeRejected({}, 'resend');
	});

	it('never stamps an unconfigured routed core provider — it falls back to the ready env provider', async () => {
		vi.stubEnv('RESEND_API_KEY', '');
		await expectNonCampaignIntakeFallsBackToEnv({}, 'resend');
	});

	it('stamps the ready environment provider when no route table applies', async () => {
		const t = convexTest(schema, modules);
		const outcome = await intakeAutomation(t);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		const send = await t.run(async (ctx) => ctx.db.get(outcome.sendId));
		expect(send).toMatchObject({ status: 'queued', email: 'recipient@example.com' });
		// The intake's own env-fallback resolution — no producer supplied one.
		expect(send?.providerType).toBe('mta');
	});

	it('queues delayed recipients for worker-time re-resolution when readiness changes', async () => {
		vi.stubEnv('EMAIL_PROVIDER', pluginKind);
		const { t, campaignId } = await seedPluginReadinessScenario({});
		expect(await t.run(async (ctx) => resolveSendRouteFromDb(ctx, 'campaign'))).toEqual({
			providerType: pluginKind,
			source: 'env_fallback',
			warmupOverflowEnabled: false,
		});

		const recipients = await t.run(async (ctx) => {
			await ctx.db.patch(campaignId, { status: 'sending' });
			const results = [];
			for (const email of ['first@example.com', 'second@example.com']) {
				const contactId = await ctx.db.insert('contacts', createTestContact({ email }));
				const emailSendId = await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ campaignId, contactId, contactEmail: email })
				);
				results.push({ contactId, emailSendId, email });
			}
			const settings = await ctx.db.query('instanceSettings').first();
			if (!settings) throw new Error('Expected instance settings');
			await ctx.db.patch(settings._id, {
				featureFlags: { [pluginFlag]: false },
			});
			return results;
		});
		// The delayed enqueue must not freeze or reject the stale provider choice.
		// The worker resolves the current route for each recipient immediately
		// before dispatch, where the now-ready MTA route replaces it.
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		const { campaignEmailPool } = await import('../../../delivery/workpool');
		const enqueueAction = vi.mocked(campaignEmailPool.enqueueAction);
		enqueueAction.mockClear();

		await expect(
			t.mutation(internal.delivery.enqueue.enqueueCampaignEmails, {
				campaignId,
				emails: recipients,
				from: 'Owlat <sender@example.com>',
				subject: 'Hello',
				htmlContent: '<p>Hello</p>',
				providerType: pluginKind,
			})
		).resolves.toEqual({ enqueued: 2 });
		expect(enqueueAction).toHaveBeenCalledTimes(2);

		const outcome = await t.run(async (ctx) => ({
			campaign: await ctx.db.get(campaignId),
			sends: await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
				.collect(),
		}));
		expect(outcome.sends).toHaveLength(2);
		expect(outcome.sends).toEqual(
			expect.arrayContaining(
				recipients.map((recipient) =>
					expect.objectContaining({
						_id: recipient.emailSendId,
						status: 'queued',
					})
				)
			)
		);
		expect(outcome.campaign?.status).toBe('sending');
	});
});
