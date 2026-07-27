/**
 * P0-5 regression — the shipped pre-flight ladder is UNCHANGED.
 *
 * The binding capacity gate is an ADDED predicate appended after every shipped
 * check, not a rewrite of pre-flight. These tests pin the ladder: with a
 * warming deployment whose capacity WOULD refuse the campaign, each shipped
 * failure still wins, in the same order, with the same reason, and the
 * capacity gate only speaks once every shipped check has passed.
 *
 * They go through `validateReadyToSend` (via `runPreflight`) rather than
 * `validateReadyToSendQuery`, because the query path deliberately disables the
 * capacity gate — running the ladder with the gate ENABLED is the whole point.
 *
 * `campaignPreflight.integration.test.ts` keeps its per-reason assertions;
 * this file adds the ordering proof.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
	createTestTopic,
} from './factories';
import {
	MIDNIGHT,
	runPreflight,
	seedWarmingState,
	useMtaPreflightEnv,
	type TestRunner,
} from './preflightFixtures';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock } = await import('./preflightFixtures');
	return await sessionOrganizationMock();
});

const modules = import.meta.glob('../**/*.*s');

/** An audience far larger than the seeded warming capacity can deliver. */
const OVERSIZED_AUDIENCE = 600;

useMtaPreflightEnv();

async function seedOversizedTopic(t: TestRunner): Promise<Id<'topics'>> {
	let topicId: Id<'topics'>;
	await t.run(async (ctx) => {
		topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		for (let i = 0; i < OVERSIZED_AUDIENCE; i += 1) {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: `person-${i}@subscriber.example.com`, doiStatus: 'confirmed' })
			);
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: MIDNIGHT });
		}
	});
	return topicId!;
}

describe('pre-flight ladder — shipped checks still win over the capacity gate', () => {
	it('no_template comes first even when capacity would refuse', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const topicId = await seedOversizedTopic(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: undefined,
					fromEmail: 'sender@unverified.example.com',
					audience: { kind: 'topic', topicId },
				})
			);
		});

		const result = await runPreflight(t, campaignId!);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('no_template');
		expect(result.message).toBe('Campaign must have an email template selected');
	});

	it('no_audience comes before the capacity gate (there is nothing to plan)', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'draft', emailTemplateId: templateId })
			);
		});

		const result = await runPreflight(t, campaignId!);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('no_audience');
		expect(result.message).toBe('Campaign must have an audience configured');
	});

	it('no_from_email still precedes the abuse-status and capacity checks', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const topicId = await seedOversizedTopic(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				abuseStatus: 'suspended',
				createdAt: MIDNIGHT,
				updatedAt: MIDNIGHT,
			});
			const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
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

		const result = await runPreflight(t, campaignId!);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('no_from_email');
	});

	it('sending_not_allowed (suspended) still precedes the provider, domain and capacity checks', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const topicId = await seedOversizedTopic(t);
		delete process.env['EMAIL_PROVIDER'];
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				abuseStatus: 'suspended',
				createdAt: MIDNIGHT,
				updatedAt: MIDNIGHT,
			});
			const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
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

		const result = await runPreflight(t, campaignId!);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('sending_not_allowed');
	});

	it('no_delivery_provider still precedes the domain and capacity checks', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const topicId = await seedOversizedTopic(t);
		delete process.env['EMAIL_PROVIDER'];
		delete process.env['MTA_API_URL'];
		delete process.env['MTA_API_KEY'];
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
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

		const result = await runPreflight(t, campaignId!);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('no_delivery_provider');
	});

	it('domain_not_verified still precedes the sender and capacity checks', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const topicId = await seedOversizedTopic(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
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

		const result = await runPreflight(t, campaignId!);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('domain_not_verified');
	});

	it('sender_not_allowed still precedes the capacity check', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const topicId = await seedOversizedTopic(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verified.example.com',
					status: 'verified',
					lastVerifiedAt: MIDNIGHT,
				})
			);
			// A curated sender exists, but not this one.
			await ctx.db.insert(
				'campaignSenders',
				createTestCampaignSender({ email: 'someone-else@verified.example.com' })
			);
			const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
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

		const result = await runPreflight(t, campaignId!);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('sender_not_allowed');
	});

	it('scheduled_in_past still precedes the capacity check on the schedule path', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const topicId = await seedOversizedTopic(t);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verified.example.com',
					status: 'verified',
					lastVerifiedAt: MIDNIGHT,
				})
			);
			await ctx.db.insert(
				'campaignSenders',
				createTestCampaignSender({ email: 'sender@verified.example.com' })
			);
			const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
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

		await expect(
			t.mutation(api.campaigns.scheduling.schedule, {
				campaignId: campaignId!,
				scheduledAt: MIDNIGHT - 60_000,
			})
		).rejects.toThrow(/future/i);
	});
});
