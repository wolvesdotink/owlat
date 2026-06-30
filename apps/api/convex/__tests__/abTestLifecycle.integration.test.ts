import { convexTest } from 'convex-test';
import { describe, it, expect, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestCampaign } from './factories';
import type { Id } from '../_generated/dataModel';

const modules = import.meta.glob('../**/*.*s');

// `→ winner_selected` schedules `internal.campaigns.send.sendCampaignWinnerToRemainder`.
// Let scheduled functions drain before the next test to avoid "Write outside
// of transaction" leaks (same pattern as campaignLifecycle.integration.test.ts).
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

const VALID_AB_CONFIG = {
	testType: 'subject' as const,
	variantBSubject: 'Alt subject',
	splitPercentage: 20,
	winnerCriteria: 'open_rate' as const,
};

describe('AB test lifecycle — happy path transitions', () => {
	it('(none) → pending sets isABTest, abTestConfig, abTestStatus, audit log', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'draft', isABTest: false })
			);
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'pending', at: Date.now(), config: VALID_AB_CONFIG },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.from).toBe('none');
		expect(outcome.to).toBe('pending');

		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(campaignId!);
			expect(campaign?.isABTest).toBe(true);
			expect(campaign?.abTestStatus).toBe('pending');
			expect(campaign?.abTestConfig?.testType).toBe('subject');
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('ab_test.enabled');
		});
	});

	it('pending → testing patches status, writes ab_test.testing_started audit', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'sending',
					isABTest: true,
					abTestConfig: VALID_AB_CONFIG,
					abTestStatus: 'pending',
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'testing', at: Date.now() },
			userId: 'system:campaign_lifecycle',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(campaignId!);
			expect(campaign?.abTestStatus).toBe('testing');
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('ab_test.testing_started');
		});
	});

	it('testing → winner_selected writes abWinner, abWinnerSelectedAt, audit', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'sending',
					isABTest: true,
					abTestConfig: VALID_AB_CONFIG,
					abTestStatus: 'testing',
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'winner_selected', at: Date.now(), winner: 'B' },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(campaignId!);
			expect(campaign?.abTestStatus).toBe('winner_selected');
			expect(campaign?.abWinner).toBe('B');
			expect(campaign?.abWinnerSelectedAt).toBeDefined();
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('ab_test.winner_declared');
		});
	});

	it('* → none resets the full AB test field block + audit', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					isABTest: true,
					abTestConfig: VALID_AB_CONFIG,
					abTestStatus: 'pending',
					abVariantBSent: 5,
					abVariantBOpened: 2,
					abVariantBClicked: 1,
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'none', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(campaignId!);
			expect(campaign?.isABTest).toBe(false);
			expect(campaign?.abTestStatus).toBeUndefined();
			expect(campaign?.abTestConfig).toBeUndefined();
			expect(campaign?.abVariantBSent).toBeUndefined();
			expect(campaign?.abVariantBOpened).toBeUndefined();
			expect(campaign?.abVariantBClicked).toBeUndefined();
			expect(campaign?.abWinner).toBeUndefined();
			expect(campaign?.abWinnerSelectedAt).toBeUndefined();
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('ab_test.disabled');
		});
	});
});

describe('AB test lifecycle — illegal edges', () => {
	it('pending → winner_selected is refused as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					isABTest: true,
					abTestConfig: VALID_AB_CONFIG,
					abTestStatus: 'pending',
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'winner_selected', at: Date.now(), winner: 'A' },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('illegal_edge');
	});

	it('(none) → testing is refused as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign({ isABTest: false }));
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'testing', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('illegal_edge');
	});

	it('winner_selected → testing is refused as illegal_edge', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					isABTest: true,
					abTestConfig: VALID_AB_CONFIG,
					abTestStatus: 'winner_selected',
					abWinner: 'A',
					abWinnerSelectedAt: Date.now() - 1000,
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'testing', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('illegal_edge');
	});
});

describe('AB test lifecycle — outcome shapes', () => {
	it('duplicate (same state) returns applied: recorded with audit row', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					isABTest: true,
					abTestConfig: VALID_AB_CONFIG,
					abTestStatus: 'pending',
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'pending', at: Date.now(), config: VALID_AB_CONFIG },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('recorded');

		await t.run(async (ctx) => {
			const audit = await ctx.db
				.query('auditLogs').collect().then((logs) => logs.find((l) => l.resourceId === campaignId!));
			expect(audit?.action).toBe('ab_test.enabled');
		});
	});

	it('unknown campaignId returns campaign_not_found', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			await ctx.db.delete(campaignId);
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'pending', at: Date.now(), config: VALID_AB_CONFIG },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('campaign_not_found');
	});
});

describe('AB test lifecycle — winner-remainder side effect', () => {
	// The schedule_winner_remainder effect schedules
	// internal.campaigns.send.sendCampaignWinnerToRemainder. convex-test runs
	// scheduled functions with delay=0 eagerly (before the next t.run can
	// query _scheduled_functions), so we can't reliably assert against
	// that table — and the orchestrator action is 'use node', which
	// hits the same "Transaction not started" timing issue when it tries
	// to run queries from the test runtime. Instead these tests verify
	// the *transition* completes (the schedule itself is verified by
	// code inspection of abTestLifecycle.ts:applyEffects and by the
	// orchestrator's unit tests in campaignSendVariantSplit.test.ts).
	it('→ winner_selected completes the transition (winner-remainder is scheduled out-of-band)', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'sending',
					isABTest: true,
					abTestConfig: VALID_AB_CONFIG,
					abTestStatus: 'testing',
				})
			);
		});

		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'winner_selected', at: Date.now(), winner: 'B' },
			userId: 'user_1',
		});

		// Transition succeeded — patch + audit + schedule_winner_remainder
		// effects all ran without throwing. The orchestrator's downstream
		// behavior is covered by its own unit tests.
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('transitioned');

		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(campaignId!);
			expect(campaign?.abTestStatus).toBe('winner_selected');
			expect(campaign?.abWinner).toBe('B');
		});
	});

	it('duplicate winner_selected (same state) returns recorded, never re-triggers remainder', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'sending',
					isABTest: true,
					abTestConfig: VALID_AB_CONFIG,
					abTestStatus: 'winner_selected',
					abWinner: 'A',
					abWinnerSelectedAt: Date.now() - 1000,
				})
			);
		});

		// Same-state transition — should be 'recorded' (no patch, no effects
		// beyond audit). The schedule_winner_remainder effect only fires from
		// the actual transition reducer, not the same-state recorded path.
		const outcome = await t.mutation(internal.campaigns.abTestLifecycle.transition, {
			campaignId: campaignId!,
			input: { to: 'winner_selected', at: Date.now(), winner: 'A' },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('recorded');
	});
});
