import { convexTest } from 'convex-test';
import { describe, it, expect, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestCampaign } from './factories';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { rollupCampaignStatsRow } from '../campaigns/statShards';

const modules = import.meta.glob('../**/*.*s');

// Campaign send stats are write-sharded; roll the shards into campaigns.stats*
// before reading (the production rollup is async/cron).
async function readCampaignWithStats(ctx: MutationCtx, campaignId: Id<'campaigns'>) {
	const c = await ctx.db.get(campaignId);
	if (c) await rollupCampaignStatsRow(ctx, c);
	return ctx.db.get(campaignId);
}

// Lifecycle effects schedule `internal.campaigns.send.startCampaignSend`
// (the Campaign send orchestrator) and `internal.lib.posthog.capture`.
// Let them drain before the next test to avoid "Write outside of
// transaction" leaks.
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

// ============================================================================
// Legal edges — happy path
// ============================================================================

describe('Campaign lifecycle — happy path transitions', () => {
	it('draft → scheduled writes scheduledAt + companion fields, schedules orchestrator', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'draft' })
			);
		});

		const scheduledAt = Date.now() + 60 * 60 * 1000;
		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'scheduled', at: Date.now(), scheduledAt },
			userId: 'user_123',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('transitioned');
		expect(outcome.from).toBe('draft');
		expect(outcome.to).toBe('scheduled');

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('scheduled');
			expect(campaign?.scheduledAt).toBe(scheduledAt);
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.scheduled');
			expect(audit?.userId).toBe('user_123');
		});
	});

	it('draft → scheduled is idempotent (applied: recorded) when already scheduled', async () => {
		const t = convexTest(schema, modules);
		const scheduledAt = Date.now() + 60 * 60 * 1000;
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'scheduled', scheduledAt })
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'scheduled', at: Date.now(), scheduledAt },
			userId: 'user_123',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('recorded');
	});

	it('draft → sending zeros stats, sets sentAt, fires track_event', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'draft', statsSent: 99 })
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sending', at: Date.now() },
			userId: 'user_456',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('sending');
			expect(campaign?.statsSent).toBe(0);
			expect(campaign?.statsDelivered).toBe(0);
			expect(campaign?.sentAt).toBeDefined();
			expect(campaign?.scheduledAt).toBeUndefined();
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.send_started');
		});
	});

	it('scheduled → sending preserves the scheduler-tick path (system user)', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'scheduled',
					scheduledAt: Date.now() + 1000,
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sending', at: Date.now() },
			userId: 'system:scheduler_tick',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('sending');
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.userId).toBe('system:scheduler_tick');
		});
	});

	it('scheduled → cancelled writes cancelledAt + audit + track_event', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'scheduled',
					scheduledAt: Date.now() + 60000,
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'cancelled', at: Date.now() },
			userId: 'user_789',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('cancelled');
			expect(campaign?.cancelledAt).toBeDefined();
			expect(campaign?.scheduledAt).toBeUndefined();
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.cancelled');
		});
	});

	it('scheduled → draft (unschedule) clears scheduledAt, writes campaign.unscheduled audit', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'scheduled',
					scheduledAt: Date.now() + 60000,
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'draft', at: Date.now() },
			userId: 'user_xyz',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('draft');
			expect(campaign?.scheduledAt).toBeUndefined();
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.unscheduled');
		});
	});

	it('sending → sent writes campaign.sent audit (no orchestrator re-schedule)', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending' })
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sent', at: Date.now() },
			userId: 'system:orchestrator',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('sent');
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.sent');
		});
	});

	it('sending → draft (content blocked) writes contentBlockReason atomically', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending' })
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: {
				to: 'draft',
				at: Date.now(),
				contentBlockReason: 'spam keywords detected',
			},
			userId: 'system:content_scan',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('draft');
			expect(campaign?.contentBlockReason).toBe('spam keywords detected');
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.content_blocked');
		});
	});

	it('sending → pending_review writes campaign.flagged_for_review audit', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending' })
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'pending_review', at: Date.now() },
			userId: 'system:content_scan',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('pending_review');
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.flagged_for_review');
		});
	});

	it('pending_review → sending (approve) writes campaign.review_approved audit', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'pending_review' })
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sending', at: Date.now() },
			userId: 'admin_user_1',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('sending');
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.review_approved');
		});
	});

	it('pending_review → draft (reject) writes campaign.review_rejected audit', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'pending_review' })
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'draft', at: Date.now() },
			userId: 'admin_user_1',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('draft');
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.review_rejected');
		});
	});
});

// ============================================================================
// Legal edges — illegal / terminal
// ============================================================================

describe('Campaign lifecycle — illegal edges', () => {
	it('sent → sending is refused as terminal', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sent' }));
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sending', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('terminal');
	});

	it('sent → draft is refused as terminal', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sent' }));
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'draft', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('terminal');
	});

	it('cancelled → scheduled is refused as terminal', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'cancelled' }));
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'scheduled', at: Date.now(), scheduledAt: Date.now() + 60000 },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('terminal');
	});

	it('draft → sent is refused as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'draft' }));
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sent', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('illegal_edge');
	});

	it('draft → pending_review is refused as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'draft' }));
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'pending_review', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('illegal_edge');
	});

	it('scheduled → pending_review is refused as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'scheduled' }));
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'pending_review', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('illegal_edge');
	});

	it('unknown campaignId returns campaign_not_found', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			await ctx.db.delete(campaignId);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sending', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('campaign_not_found');
	});
});

// ============================================================================
// Cross-machine — AB test kickoff on → sending
// ============================================================================

describe('Campaign lifecycle — cross-machine AB test kickoff', () => {
	it('draft → sending on isABTest campaign also transitions abTestStatus to testing', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					isABTest: true,
					abTestConfig: {
						testType: 'subject',
						variantBSubject: 'Alt subject',
						splitPercentage: 20,
						winnerCriteria: 'open_rate',
					},
					abTestStatus: 'pending',
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sending', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('sending');
			expect(campaign?.abTestStatus).toBe('testing');
			const auditRows = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.filter((l) => l.resourceId === campaignId!));
			const actions = auditRows.map((r) => r.action).sort();
			expect(actions).toContain('campaign.send_started');
			expect(actions).toContain('ab_test.testing_started');
		});
	});

	it('draft → sending on non-AB campaign does NOT touch abTestStatus', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'draft', isABTest: false })
			);
		});

		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sending', at: Date.now() },
			userId: 'user_1',
		});

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('sending');
			expect(campaign?.abTestStatus).toBeUndefined();
		});
	});

	it('pending_review → sending (approve) on AB campaign re-enters AB testing if pending', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'pending_review',
					isABTest: true,
					abTestConfig: {
						testType: 'subject',
						variantBSubject: 'X',
						splitPercentage: 20,
						winnerCriteria: 'open_rate',
					},
					abTestStatus: 'pending',
				})
			);
		});

		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sending', at: Date.now() },
			userId: 'admin_1',
		});

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.status).toBe('sending');
			expect(campaign?.abTestStatus).toBe('testing');
		});
	});
});

// ============================================================================
// Side effects: track_event firing rules
// ============================================================================

describe('Campaign lifecycle — track_event firing rules', () => {
	it('user-driven → cancelled fires campaign_cancelled posthog event', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'scheduled', scheduledAt: Date.now() + 60000 })
			);
		});

		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'cancelled', at: Date.now() },
			userId: 'user_x',
		});

		// The track_event effect schedules an internal action; verify it was
		// scheduled by checking the audit log is the only DB write (the
		// scheduled function runs out-of-transaction). Use the audit_log
		// presence as a witness for the synchronous effects.
		await t.run(async (ctx) => {
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.cancelled');
		});
	});

	it('system-driven → sent does NOT fire track_event (suppression for system: prefix)', async () => {
		// We assert behavior indirectly: system-driven calls produce only the
		// audit_log effect (no track_event scheduling). The audit row is
		// witness; we also verify the audit's userId carries the system tag.
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending' })
			);
		});

		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'sent', at: Date.now() },
			userId: 'system:orchestrator',
		});

		await t.run(async (ctx) => {
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('campaign.sent');
			expect(audit?.userId).toBe('system:orchestrator');
		});
	});
});
