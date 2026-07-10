import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestDomain,
	createTestEmailTemplate,
} from './factories';
import type { Id } from '../_generated/dataModel';

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
	});
});
