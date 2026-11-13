import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestDomain,
	createTestEmailTemplate,
} from './factories';
import type { Id } from '../_generated/dataModel';
import { requireOrgMember } from '../lib/sessionOrganization';
import { PREFLIGHT_MESSAGE_KEYS } from '../campaigns/refusalCopy';
import { writeInstanceCounter } from '../lib/instanceCounters';
import { MTA_HEALTH_MAX_AGE_MS } from '../delivery/mtaHealthFreshness';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'test-user',
			issuer: 'test',
			tokenIdentifier: 'test|test-user',
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');

type TestRunner = ReturnType<typeof convexTest>;

// The pre-flight now refuses to send when no delivery provider is configured.
// These cases assume a configured provider by default; the dedicated
// `no_delivery_provider` case clears it.
beforeEach(() => {
	process.env['EMAIL_PROVIDER'] = 'mta';
	process.env['MTA_API_URL'] = 'http://mta:3100';
	process.env['MTA_API_KEY'] = 'test-key';
});
afterEach(() => {
	delete process.env['EMAIL_PROVIDER'];
	delete process.env['MTA_API_URL'];
	delete process.env['MTA_API_KEY'];
});

async function seedTemplate(t: TestRunner): Promise<Id<'emailTemplates'>> {
	let id: Id<'emailTemplates'>;
	await t.run(async (ctx) => {
		id = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
	});
	return id!;
}

async function seedVerifiedDomain(t: TestRunner, domain: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({
				domain,
				status: 'verified',
				lastVerifiedAt: Date.now(),
			})
		);
	});
}

async function seedTopic(t: TestRunner): Promise<Id<'topics'>> {
	let id: Id<'topics'>;
	await t.run(async (ctx) => {
		id = await ctx.db.insert('topics', {
			name: 'General',
			description: '',
			isDefault: false,
			createdAt: Date.now(),
		});
	});
	return id!;
}

describe('validateReadyToSend pre-flight', () => {
	it('no_template — campaign has no emailTemplateId', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'draft', emailTemplateId: undefined })
			);
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: campaignId!,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('no_template');
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.no_template.missing);
	});

	it('no_audience — campaign has no audience', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					// no audience configured
				})
			);
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: campaignId!,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('no_audience');
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.no_audience.default);
	});

	it('no_from_email — campaign has no fromEmail', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const topicId = await seedTopic(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					fromEmail: undefined,
					audience: { kind: 'topic', topicId },
				})
			);
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: campaignId!,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('no_from_email');
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.no_from_email.default);
	});

	it('sending_not_allowed — instance is suspended', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const topicId = await seedTopic(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				abuseStatus: 'suspended',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					fromEmail: 'sender@example.com',
					audience: { kind: 'topic', topicId },
				})
			);
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: campaignId!,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('sending_not_allowed');
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.sending_not_allowed.suspended);
	});

	it('domain_not_verified — sending domain has no domains row', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const topicId = await seedTopic(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					fromEmail: 'sender@unverified.example.com',
					audience: { kind: 'topic', topicId },
				})
			);
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: campaignId!,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('domain_not_verified');
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.domain_not_verified.missing);
		expect(result.messageParams).toEqual({ domain: 'unverified.example.com' });
	});

	it('no_delivery_provider — reported before the domain check when no provider is configured', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const topicId = await seedTopic(t);
		// No provider configured: even an unverified domain reports the provider first.
		delete process.env['EMAIL_PROVIDER'];
		delete process.env['MTA_API_URL'];
		delete process.env['MTA_API_KEY'];
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					fromEmail: 'sender@unverified.example.com',
					audience: { kind: 'topic', topicId },
				})
			);
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: campaignId!,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('no_delivery_provider');
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.no_delivery_provider.default);
	});

	it('ok — all checks pass with verified domain and template+audience+fromEmail', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const topicId = await seedTopic(t);
		await seedVerifiedDomain(t, 'verified.example.com');
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaignSenders',
				createTestCampaignSender({ email: 'sender@verified.example.com' })
			);
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					fromEmail: 'sender@verified.example.com',
					audience: { kind: 'topic', topicId },
				})
			);
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: campaignId!,
		});

		expect(result.ok).toBe(true);
	});

	it('answers with no signed-in member, as the scheduler and the orchestrator run it', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const topicId = await seedTopic(t);
		await seedVerifiedDomain(t, 'verified.example.com');
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaignSenders',
				createTestCampaignSender({ email: 'sender@verified.example.com' })
			);
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'scheduled',
					emailTemplateId: templateId,
					fromEmail: 'sender@verified.example.com',
					audience: { kind: 'topic', topicId },
				})
			);
		});
		// A scheduled function carries no identity: any member check on the way
		// would refuse it.
		vi.mocked(requireOrgMember).mockRejectedValue(new Error('Not authenticated'));
		try {
			const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
				campaignId: campaignId!,
			});
			expect(result.ok).toBe(true);
		} finally {
			vi.mocked(requireOrgMember).mockResolvedValue({
				userId: 'test-user',
				role: 'owner',
			} as never);
		}
	});

	it('not_found (unknown campaign) — campaign not found path', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			await ctx.db.delete(campaignId);
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId: campaignId!,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		// A missing campaign row is reported as not_found rather than being
		// mislabelled as a missing template.
		expect(result.reason).toBe('not_found');
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.not_found.default);
	});
});

describe('validateReadyToSend — the built-in mail server', () => {
	const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
		delete process.env['RESEND_API_KEY'];
	});

	/** A campaign every other check passes, sending from `sender@verified.example.com`. */
	async function seedReadyCampaign(t: TestRunner): Promise<Id<'campaigns'>> {
		const templateId = await seedTemplate(t);
		const topicId = await seedTopic(t);
		await seedVerifiedDomain(t, 'verified.example.com');
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaignSenders',
				createTestCampaignSender({ email: 'sender@verified.example.com' })
			);
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					fromEmail: 'sender@verified.example.com',
					audience: { kind: 'topic', topicId },
				})
			);
		});
		return campaignId!;
	}

	/** The MTA's health as the sync records it: port 25 refused from every address. */
	async function seedPort25Blocked(t: TestRunner, observedAt: number): Promise<void> {
		await t.run(async (ctx) => {
			await writeInstanceCounter(ctx, 'mtaHealth', {
				mtaHealth: {
					status: 'degraded',
					smtpOutbound: {
						status: 'degraded',
						checkedAt: observedAt,
						ips: [
							{ ip: '192.0.2.10', status: 'failed', reason: 'connect ETIMEDOUT' },
							{ ip: '192.0.2.11', status: 'failed', reason: 'connect ETIMEDOUT' },
						],
					},
					observedAt,
				},
			});
		});
	}

	it('refuses a campaign on the own MTA when a fresh snapshot says port 25 is blocked', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t);
		await seedPort25Blocked(t, NOW - 60_000);

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('mail_server_not_ready');
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.mail_server_not_ready.port25Blocked);
	});

	it('refuses when the mail server does not answer its health check', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t);
		await t.run(async (ctx) => {
			await writeInstanceCounter(ctx, 'mtaHealth', {
				mtaHealth: { status: 'unreachable', observedAt: NOW - 60_000 },
			});
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.mail_server_not_ready.unreachable);
	});

	it('refuses when every campaign sending IP is held, as the hub grades it', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t);
		await t.run(async (ctx) => {
			await writeInstanceCounter(ctx, 'mtaHealth', {
				mtaHealth: { status: 'degraded', observedAt: NOW - 60_000 },
			});
			const ip = {
				phase: 'ramp',
				currentDay: 3,
				dailyCap: 100,
				sentToday: 0,
				bounceRate: 0,
				deferralRate: 0,
				active: true,
				blockReasons: ['dnsbl' as const],
			};
			await ctx.db.insert('warmingState', {
				pools: { transactional: ['192.0.2.20'], campaign: ['192.0.2.10'] },
				phase: 'ramp',
				totalDailyCap: 100,
				totalSentToday: 0,
				ipCount: 2,
				ips: [
					{ ...ip, ip: '192.0.2.10', pool: 'campaign' },
					{ ...ip, ip: '192.0.2.20', pool: 'transactional', blockReasons: [] },
				],
				syncedAt: NOW - 60_000,
			});
		});

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.messageKey).toBe(PREFLIGHT_MESSAGE_KEYS.mail_server_not_ready.allIpsHeld);
	});

	it('does not refuse on a stale snapshot: a stopped sync says nothing about the server', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t);
		await seedPort25Blocked(t, NOW - MTA_HEALTH_MAX_AGE_MS - 60_000);

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(true);
	});

	it('does not judge a relay route by the built-in MTA', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedReadyCampaign(t);
		await seedPort25Blocked(t, NOW - 60_000);
		process.env['EMAIL_PROVIDER'] = 'resend';
		process.env['RESEND_API_KEY'] = 're_test';

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(true);
	});
});

describe('getCampaignDeliveryConfigured', () => {
	it('answers true when campaign mail has a ready provider', async () => {
		const t = convexTest(schema, modules);
		expect(await t.query(api.campaigns.preflight.getCampaignDeliveryConfigured, {})).toBe(true);
	});

	it('answers false exactly where the pre-flight refuses with no_delivery_provider', async () => {
		const t = convexTest(schema, modules);
		delete process.env['EMAIL_PROVIDER'];
		delete process.env['MTA_API_URL'];
		delete process.env['MTA_API_KEY'];
		expect(await t.query(api.campaigns.preflight.getCampaignDeliveryConfigured, {})).toBe(false);
	});
});
