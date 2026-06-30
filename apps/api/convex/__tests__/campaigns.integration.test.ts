import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestEmailSend,
	createTestEmailSendWithHistory,
	createTestContact,
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
	};
});

const modules = import.meta.glob('../**/*.*s');

// ============ Campaign Queries ============

describe('campaigns.get', () => {
	it('should return campaign by ID', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ name: 'Test Campaign' })
			);
		});

		const campaign = await t.query(api.campaigns.campaigns.get, {
			campaignId: campaignId!,
		});

		expect(campaign).toBeDefined();
		expect(campaign?.name).toBe('Test Campaign');
	});

	it('should return null for non-existent campaign', async () => {
		const t = convexTest(schema, modules);

		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			await ctx.db.delete(campaignId);
		});

		const campaign = await t.query(api.campaigns.campaigns.get, {
			campaignId: campaignId!,
		});

		expect(campaign).toBeNull();
	});
});

// ============ A/B Testing Query ============

describe('campaigns.getABTestStats', () => {
	it('should return null for non-AB test campaign', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ isABTest: false })
			);
		});

		const stats = await t.query(api.campaigns.abTest.getABTestStats, {
			campaignId: campaignId!,
		});

		expect(stats).toBeNull();
	});

	it('should return AB test stats with zero sends', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					isABTest: true,
					abTestConfig: {
						testType: 'subject',
						variantBSubject: 'Alt Subject',
						splitPercentage: 20,
						winnerCriteria: 'open_rate',
					},
					abTestStatus: 'testing',
				})
			);
		});

		const stats = await t.query(api.campaigns.abTest.getABTestStats, {
			campaignId: campaignId!,
		});

		expect(stats).toBeDefined();
		expect(stats!.status).toBe('testing');
		expect(stats!.config).toBeDefined();
		expect(stats!.config!.testType).toBe('subject');
		expect(stats!.config!.splitPercentage).toBe(20);
		expect(stats!.variantA.sent).toBe(0);
		expect(stats!.variantA.openRate).toBe(0);
		expect(stats!.variantB.sent).toBe(0);
		expect(stats!.variantB.openRate).toBe(0);
	});

	it('should calculate correct open/click rates for variants', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					isABTest: true,
					abTestConfig: {
						testType: 'subject',
						variantBSubject: 'Alt Subject',
						splitPercentage: 50,
						winnerCriteria: 'open_rate',
					},
					abTestStatus: 'testing',
				})
			);

			const contactId = await ctx.db.insert('contacts', createTestContact());

			// Variant A: 4 delivered — 3 opened (incl. 1 clicked), 1 clicked.
			// Uses realistic lifecycle timestamps (the lifecycle always stamps
			// deliveredAt/openedAt/clickedAt alongside status); stats are
			// counted by timestamp, with "ever delivered" as the rate
			// denominator (consistent with the main campaign report).
			for (const status of ['delivered', 'opened', 'opened', 'clicked'] as const) {
				await ctx.db.insert(
					'emailSends',
					createTestEmailSendWithHistory(status, {
						campaignId,
						contactId,
						abVariant: 'A',
					})
				);
			}

			// Variant B: 4 delivered — 3 opened (incl. 2 clicked), 2 clicked.
			for (const status of ['delivered', 'opened', 'clicked', 'clicked'] as const) {
				await ctx.db.insert(
					'emailSends',
					createTestEmailSendWithHistory(status, {
						campaignId,
						contactId,
						abVariant: 'B',
					})
				);
			}
		});

		const stats = await t.query(api.campaigns.abTest.getABTestStats, {
			campaignId: campaignId!,
		});

		expect(stats).toBeDefined();

		// Variant A: 4 total, opened/clicked = 3 (2 opened + 1 clicked), clicked = 1
		expect(stats!.variantA.sent).toBe(4);
		expect(stats!.variantA.opened).toBe(3); // opened + clicked count as opened
		expect(stats!.variantA.clicked).toBe(1);
		expect(stats!.variantA.openRate).toBe(75); // 3/4 * 100

		// Variant B: 4 total, opened/clicked = 3 (1 opened + 2 clicked), clicked = 2
		expect(stats!.variantB.sent).toBe(4);
		expect(stats!.variantB.opened).toBe(3); // opened + clicked
		expect(stats!.variantB.clicked).toBe(2);
		expect(stats!.variantB.openRate).toBe(75); // 3/4 * 100
		expect(stats!.variantB.clickRate).toBe(50); // 2/4 * 100
	});

	it('should handle missing abTestConfig gracefully', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					isABTest: true,
					abTestConfig: undefined,
					abTestStatus: 'testing',
				})
			);
		});

		const stats = await t.query(api.campaigns.abTest.getABTestStats, {
			campaignId: campaignId!,
		});

		expect(stats).toBeDefined();
		expect(stats!.config).toBeNull();
	});

	it('should include winner info when available', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		const winnerTime = Date.now();

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					isABTest: true,
					abTestConfig: {
						testType: 'subject',
						variantBSubject: 'Alt',
						splitPercentage: 30,
						winnerCriteria: 'manual',
					},
					abTestStatus: 'winner_selected',
					abWinner: 'A',
					abWinnerSelectedAt: winnerTime,
				})
			);
		});

		const stats = await t.query(api.campaigns.abTest.getABTestStats, {
			campaignId: campaignId!,
		});

		expect(stats!.status).toBe('winner_selected');
		expect(stats!.winner).toBe('A');
		expect(stats!.winnerSelectedAt).toBe(winnerTime);
	});
});

// ============ Campaign Analytics Queries ============

describe('campaignsAnalytics.getActiveByOrganization', () => {
	it('should return scheduled and sending campaigns', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'scheduled',
					scheduledAt: Date.now() + 86400000,
				})
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending', sentAt: Date.now() })
			);
			await ctx.db.insert('campaigns', createTestCampaign({ status: 'draft' }));
			await ctx.db.insert('campaigns', createTestCampaign({ status: 'sent' }));
		});

		const active = await t.query(api.campaigns.analytics.getActiveByOrganization, {

		});

		expect(active).toHaveLength(2);
		const statuses = active.map((c: { status: string }) => c.status);
		expect(statuses).toContain('scheduled');
		expect(statuses).toContain('sending');
	});

	it('should respect limit parameter', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert(
					'campaigns',
					createTestCampaign({
						status: 'scheduled',
						scheduledAt: Date.now() + i * 1000,
					})
				);
			}
		});

		const active = await t.query(api.campaigns.analytics.getActiveByOrganization, {

			limit: 3,
		});

		expect(active).toHaveLength(3);
	});

	it('should return empty array for org with no active campaigns', async () => {
		const t = convexTest(schema, modules);

		const active = await t.query(api.campaigns.analytics.getActiveByOrganization, {

		});

		expect(active).toHaveLength(0);
	});

	it('should sort by time (earliest first)', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'Later',
					status: 'scheduled',
					scheduledAt: now + 200000,
				})
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'Earlier',
					status: 'scheduled',
					scheduledAt: now + 100000,
				})
			);
		});

		const active = await t.query(api.campaigns.analytics.getActiveByOrganization, {

		});

		expect(active[0]!.name).toBe('Earlier');
		expect(active[1]!.name).toBe('Later');
	});
});

describe('campaignsAnalytics.getTopPerformingByOrganization', () => {
	it('should return sent campaigns sorted by open rate', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'High',
					status: 'sent',
					sentAt: Date.now(),
					statsDelivered: 100,
					statsOpened: 80,
				})
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'Low',
					status: 'sent',
					sentAt: Date.now(),
					statsDelivered: 100,
					statsOpened: 20,
				})
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'Medium',
					status: 'sent',
					sentAt: Date.now(),
					statsDelivered: 100,
					statsOpened: 50,
				})
			);
		});

		const top = await t.query(api.campaigns.analytics.getTopPerformingByOrganization, {

		});

		expect(top).toHaveLength(3);
		expect(top[0]!.name).toBe('High');
		expect(top[0]!.openRate).toBe(80);
		expect(top[1]!.name).toBe('Medium');
		expect(top[2]!.name).toBe('Low');
	});

	it('should exclude campaigns with no deliveries', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'HasDeliveries',
					status: 'sent',
					sentAt: Date.now(),
					statsDelivered: 50,
					statsOpened: 25,
				})
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'NoDeliveries',
					status: 'sent',
					sentAt: Date.now(),
					statsDelivered: 0,
					statsOpened: 0,
				})
			);
		});

		const top = await t.query(api.campaigns.analytics.getTopPerformingByOrganization, {

		});

		expect(top).toHaveLength(1);
		expect(top[0]!.name).toBe('HasDeliveries');
	});
});

describe('campaignsAnalytics.getRecentlySentByOrganization', () => {
	it('should return sent campaigns sorted by sentAt descending', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'Old',
					status: 'sent',
					sentAt: now - 200000,
				})
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'Recent',
					status: 'sent',
					sentAt: now,
				})
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'Middle',
					status: 'sent',
					sentAt: now - 100000,
				})
			);
		});

		const recent = await t.query(
			api.campaigns.analytics.getRecentlySentByOrganization,
			{
	
			}
		);

		expect(recent).toHaveLength(3);
		expect(recent[0]!.name).toBe('Recent');
		expect(recent[1]!.name).toBe('Middle');
		expect(recent[2]!.name).toBe('Old');
	});

	it('should respect limit parameter', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert(
					'campaigns',
					createTestCampaign({
						status: 'sent',
						sentAt: Date.now() - i * 1000,
					})
				);
			}
		});

		const recent = await t.query(
			api.campaigns.analytics.getRecentlySentByOrganization,
			{
	
				limit: 3,
			}
		);

		expect(recent).toHaveLength(3);
	});

	it('should not include non-sent campaigns', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'draft' })
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'scheduled', scheduledAt: Date.now() + 100000 })
			);
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sent', sentAt: Date.now() })
			);
		});

		const recent = await t.query(
			api.campaigns.analytics.getRecentlySentByOrganization,
			{
	
			}
		);

		expect(recent).toHaveLength(1);
		expect(recent[0]!.status).toBe('sent');
	});
});

// ============ Campaign Status Pattern Tests ============

describe('campaign status transitions (data validation)', () => {
	it('campaign should preserve all fields on status update', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', {
				name: 'General',
				description: '',
				isDefault: false,
				createdAt: Date.now(),
			});
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'My Campaign',
					fromEmail: 'test@example.com',
					fromName: 'Test Sender',
					subject: 'Hello World',
					audience: { kind: 'topic', topicId },
					status: 'sending',
				})
			);
		});

		// Post-ADR-0017: status transitions go through the lifecycle module.
		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sent', at: Date.now() },
			userId: 'system:test',
		});

		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(campaignId!);
			expect(campaign?.status).toBe('sent');
			expect(campaign?.name).toBe('My Campaign');
			expect(campaign?.fromEmail).toBe('test@example.com');
			expect(campaign?.fromName).toBe('Test Sender');
			expect(campaign?.subject).toBe('Hello World');
			expect(campaign?.audience).toEqual({ kind: 'topic', topicId: topicId! });
		});
	});
});
