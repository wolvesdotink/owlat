/**
 * P0-5 — the BINDING capacity gate at pre-flight.
 *
 * A warming deployment with no relay to overflow to can start a campaign it
 * provably cannot finish; the tail then silently expires in the MTA queue.
 * These tests prove the refusal is real (with a structured multi-day plan
 * attached), that a finishable campaign is untouched, and — the case the plan
 * cares about most (D2/D10) — that UNKNOWN capacity never blocks a send.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
	createTestTopic,
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

/** UTC midnight — pins the retention horizon at exactly four usable days. */
const MIDNIGHT = Date.UTC(2026, 6, 27, 0, 0, 0);

beforeEach(() => {
	process.env['EMAIL_PROVIDER'] = 'mta';
	process.env['MTA_API_URL'] = 'http://mta:3100';
	process.env['MTA_API_KEY'] = 'test-key';
	vi.useFakeTimers();
	vi.setSystemTime(MIDNIGHT);
});

afterEach(() => {
	vi.useRealTimers();
	delete process.env['EMAIL_PROVIDER'];
	delete process.env['MTA_API_URL'];
	delete process.env['MTA_API_KEY'];
});

/**
 * A sendable campaign: template, verified domain, curated sender, and a topic
 * audience of `contactCount` eligible contacts.
 */
async function seedSendableCampaign(t: TestRunner, contactCount: number): Promise<Id<'campaigns'>> {
	let campaignId: Id<'campaigns'>;
	await t.run(async (ctx) => {
		const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
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
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		for (let i = 0; i < contactCount; i += 1) {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: `person-${i}@subscriber.example.com`, doiStatus: 'confirmed' })
			);
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: MIDNIGHT });
		}
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

/**
 * One active, day-1 warming IP. Projected capacity across the four-day
 * retention horizon is 0 (today, already spent) + 100 + 200 + 200 = 500.
 */
async function seedWarmingState(
	t: TestRunner,
	overrides: { totalSentToday?: number; syncedAt?: number; phase?: string } = {}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('warmingState', {
			phase: overrides.phase ?? 'ramp',
			totalDailyCap: 50,
			totalSentToday: overrides.totalSentToday ?? 50,
			ipCount: 1,
			ips: [
				{
					ip: '203.0.113.10',
					phase: overrides.phase ?? 'ramp',
					currentDay: 1,
					dailyCap: 50,
					sentToday: overrides.totalSentToday ?? 50,
					bounceRate: 0,
					deferralRate: 0,
					pool: 'campaign',
					active: true,
				},
			],
			syncedAt: overrides.syncedAt ?? MIDNIGHT,
		});
	});
}

describe('pre-flight capacity gate — binding refusal', () => {
	it('refuses a campaign that cannot finish inside the retention horizon, with the plan attached', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
		// 600 recipients against 0 / 100 / 200 / 200 / 700 …
		expect(result.capacityPlan).toEqual({
			days: 5,
			slices: [0, 100, 200, 200, 100],
			finishesAt: MIDNIGHT + 5 * 24 * 60 * 60 * 1000,
		});
		// The copy is a schedule, not an error.
		expect(result.message).toContain('5 days');
	});

	it('leaves a campaign that fits untouched', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 40);

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(true);
	});
});

describe('pre-flight capacity gate — never a false blocker (D2/D10)', () => {
	it('allows the send when there is no warming state at all', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(true);
	});

	it('allows the send when warming state is stale (the MTA sync stopped)', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t, { syncedAt: MIDNIGHT - 3 * 24 * 60 * 60 * 1000 });
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(true);
	});

	it('allows the send on a graduated deployment (no warming cap to bind against)', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t, { phase: 'graduated' });
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(true);
	});

	it('allows the send when the projection has no positive capacity anywhere', async () => {
		const t = convexTest(schema, modules);
		// No active IPs: nothing to project, so capacity is unknown, not zero.
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', {
				phase: 'ramp',
				totalDailyCap: 0,
				totalSentToday: 0,
				ipCount: 1,
				ips: [
					{
						ip: '203.0.113.11',
						phase: 'ramp',
						currentDay: 1,
						dailyCap: 0,
						sentToday: 0,
						bounceRate: 0,
						deferralRate: 0,
						pool: 'campaign',
						active: false,
					},
				],
				syncedAt: MIDNIGHT,
			});
		});
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(true);
	});

	it('allows a campaign whose audience resolves to zero recipients', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 0);

		const result = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(result.ok).toBe(true);
	});
});

describe('getCampaignCapacityPlan — the UI preview', () => {
	it('reports capacityKnown: false when nothing can be measured', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		});

		const plan = await t.query(api.campaigns.capacityPreflight.getCampaignCapacityPlan, {
			audience: { kind: 'topic', topicId: topicId! },
		});

		expect(plan).toEqual({ fits: true, capacityKnown: false });
	});
});
