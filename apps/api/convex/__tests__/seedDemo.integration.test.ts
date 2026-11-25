/**
 * The dev demo seed (`POST /seed/demo`, `seedDemo/index.ts`) loads one of each
 * state a report or a runs panel shows, with the counters derived from those
 * rows in agreement, and loading it again changes nothing. The sending switch
 * (`seedDemo/sendingState.ts`) suspends sending and lifts it again.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { components, internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { _resetSingletonOrgCacheForTests } from '../lib/sessionOrganization';
import { summarizeAutomationHealth } from '../automations/health';
import { newBetterAuthHarness } from './testModules';

// Midday UTC, so the failed run's start (25 hours earlier) is on the day before.
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

async function harness() {
	_resetSingletonOrgCacheForTests();
	const t = newBetterAuthHarness();
	rateLimiterTest.register(t);
	await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Demo', slug: 'demo', createdAt: NOW } },
	} as never);
	// The owner `/seed/admin` creates; the seed's mailboxes belong to it.
	await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'user',
			data: {
				email: 'dev@example.com',
				name: 'Dev Admin',
				emailVerified: true,
				createdAt: NOW,
				updatedAt: NOW,
			},
		},
	} as never);
	return t;
}
type Tester = Awaited<ReturnType<typeof harness>>;

function seed(t: Tester, reset = false) {
	return t.mutation(internal.seedDemo.index.runSeedDemo, { reset });
}

/** Everything the new states consist of, in a comparable shape. */
function snapshot(t: Tester) {
	return t.run(async (ctx) => {
		const strip = <T extends { _id: unknown; _creationTime: number }>(rows: T[]) =>
			rows.map(({ _id, _creationTime, ...rest }) => rest);
		const campaigns = await ctx.db.query('campaigns').collect();
		const sends = await ctx.db.query('emailSends').collect();
		const runs = await ctx.db.query('automationRuns').collect();
		const stepRuns = await ctx.db.query('automationStepRuns').collect();
		const steps = await ctx.db.query('automationSteps').collect();
		const automations = await ctx.db.query('automations').collect();
		const accounts = await ctx.db.query('externalMailAccounts').collect();
		const mailboxes = await ctx.db.query('mailboxes').collect();
		const health = await Promise.all(
			automations.map((a) => summarizeAutomationHealth(ctx.db, a._id, NOW))
		);
		return {
			campaigns: campaigns.map((c) => ({
				name: c.name,
				sent: c.statsSent,
				delivered: c.statsDelivered,
				bounced: c.statsBounced,
				soft: c.statsSoftBounced,
				hard: c.statsHardBounced,
				failed: c.statsFailed,
			})),
			sends: strip(sends).map(({ campaignId, contactId, ...rest }) => rest),
			runs: runs.map((r) => ({ status: r.status, endReason: r.endReason })),
			stepRuns: stepRuns.map((s) => ({
				status: s.status,
				failureReason: s.failureReason,
				waitingFor: s.waitingFor,
			})),
			steps: steps.map((s) => ({ pending: s.statPending, failed: s.statFailed })),
			automations: automations.map((a) => ({
				entered: a.statsEntered,
				active: a.statsActive,
			})),
			health,
			accounts: accounts.map((a) => ({ status: a.status, imapHost: a.imapHost })),
			mailboxes: mailboxes.map((m) => ({ address: m.address, kind: m.kind })).sort(),
		};
	});
}

describe('demo seed — unhealthy states', () => {
	it('seeds a failed and a soft-bounced send that agree with the campaign counters', async () => {
		const t = await harness();
		await seed(t);

		const { campaign, sends } = await t.run(async (ctx) => {
			const campaign = (await ctx.db.query('campaigns').collect()).find(
				(c) => c.name === 'Summer Sale 2026'
			)!;
			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', campaign._id))
				.collect();
			return { campaign, sends };
		});

		const failed = sends.filter((s) => s.status === 'failed');
		const bounced = sends.filter((s) => s.status === 'bounced');
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({
			errorCode: 'INVALID_RECIPIENT',
			errorMessage: expect.stringContaining('550 5.1.1'),
			failedAt: expect.any(Number),
		});
		expect(failed[0]!.sentAt).toBeUndefined();

		expect(bounced).toHaveLength(1);
		expect(bounced[0]).toMatchObject({
			bounceType: 'soft',
			bounceCause: 'recipient',
			errorMessage: expect.stringContaining('452 4.2.2'),
			bouncedAt: expect.any(Number),
		});
		expect(bounced[0]!.deliveredAt).toBeUndefined();

		// The counters the report header reads agree with the rows its lists read.
		const sent = sends.filter((s) => s.sentAt !== undefined);
		const delivered = sends.filter((s) => s.deliveredAt !== undefined);
		expect(campaign).toMatchObject({
			statsSent: sent.length,
			statsDelivered: delivered.length,
			statsBounced: bounced.length,
			statsSoftBounced: bounced.length,
			statsHardBounced: 0,
			statsFailed: failed.length,
		});

		// The stats columns are a cache of the shards; the rollup cron keeps them.
		await t.mutation(internal.campaigns.statShards.rollupSentCampaignStats, {});
		const rolledUp = await t.run((ctx) => ctx.db.get(campaign._id));
		expect(rolledUp).toMatchObject({
			statsSent: campaign.statsSent,
			statsDelivered: campaign.statsDelivered,
			statsBounced: campaign.statsBounced,
			statsFailed: campaign.statsFailed,
		});
	});

	it('seeds a failed and a waiting automation run with matching counters and health', async () => {
		const t = await harness();
		await seed(t);

		const state = await t.run(async (ctx) => {
			const automation = (await ctx.db.query('automations').collect())[0]!;
			const runs = await ctx.db.query('automationRuns').collect();
			const stepRuns = await ctx.db.query('automationStepRuns').collect();
			const step = (await ctx.db.query('automationSteps').collect())[0]!;
			const health = await summarizeAutomationHealth(ctx.db, automation._id, NOW);
			return { automation, runs, stepRuns, step, health };
		});

		const failedRun = state.runs.find((r) => r.status === 'cancelled')!;
		const waitingRun = state.runs.find((r) => r.status === 'running')!;
		expect(state.runs).toHaveLength(2);
		expect(failedRun.endReason).toBe('step_failed');

		const stepRunOf = (run: Doc<'automationRuns'>) =>
			state.stepRuns.find((s) => s.automationRunId === run._id)!;
		expect(stepRunOf(failedRun)).toMatchObject({
			status: 'failed',
			failureReason: 'no_default_sender',
			errorMessage: expect.stringContaining('Email sender not configured'),
		});
		expect(stepRunOf(waitingRun)).toMatchObject({
			status: 'pending',
			waitingFor: 'no_default_sender',
			waitingUntil: NOW + 24 * 60 * 60 * 1000,
			waitingCheckedAt: NOW,
		});

		expect(state.step).toMatchObject({ statPending: 1, statFailed: 1, statExecuting: 0 });
		expect(state.automation).toMatchObject({ statsEntered: 2, statsActive: 1 });
		expect(state.health).toEqual({ entered: 2, failed: 1, stalled: 0 });
	});

	it('seeds a connected mailbox with no credential for mail-sync to use', async () => {
		const t = await harness();
		await seed(t);

		const { account, mailbox } = await t.run(async (ctx) => {
			const account = (await ctx.db.query('externalMailAccounts').collect())[0]!;
			return { account, mailbox: await ctx.db.get(account.mailboxId) };
		});
		expect(mailbox).toMatchObject({
			kind: 'external',
			address: 'dev.demo@example.net',
			externalAccountId: account._id,
			status: 'active',
		});
		expect(account).toMatchObject({ status: 'connected', imapHost: 'imap.example.net' });
		expect(account.secretCiphertext).toBeUndefined();
		// The mail-sync worker is never handed it, so it never tries to connect.
		expect(
			await t.query(internal.mail.external.accounts.listConnectableAccounts, {})
		).not.toContainEqual(expect.objectContaining({ accountId: account._id }));
	});

	it('gives the same rows when seeded twice, and again after a reset', async () => {
		const t = await harness();
		await seed(t);
		const first = await snapshot(t);

		const again = await seed(t);
		expect(again.inserted).toMatchObject({ automationRuns: 0, connectedMailboxes: 0 });
		expect(await snapshot(t)).toEqual(first);

		const reset = await seed(t, true);
		expect(reset.deleted?.['automationRuns']).toBe(2);
		expect(await snapshot(t)).toEqual(first);
		// No run is left pointing at the automation the reset deleted.
		const orphans = await t.run(async (ctx) => {
			const runs = await ctx.db.query('automationRuns').collect();
			const live = await Promise.all(runs.map((r) => ctx.db.get(r.automationId)));
			return live.filter((a) => a === null).length;
		});
		expect(orphans).toBe(0);
		const shards = await t.run(async (ctx) => {
			const rows = await ctx.db.query('campaignStatShards').collect();
			const live = await Promise.all(rows.map((r) => ctx.db.get(r.campaignId)));
			return { total: rows.length, orphaned: live.filter((c) => c === null).length };
		});
		expect(shards).toEqual({ total: 1, orphaned: 0 });
	});
});

describe('demo seed — sending switch', () => {
	it('suspends sending, reports it, and lifts it again', async () => {
		const t = await harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', { contactCount: 0, createdAt: NOW });
		});

		expect(await t.query(internal.seedDemo.sendingState.getDemoSendingState, {})).toMatchObject({
			abuseStatus: 'clean',
		});

		const suspended = await t.mutation(internal.seedDemo.sendingState.setDemoSendingSuspended, {
			suspended: true,
		});
		expect(suspended).toMatchObject({ abuseStatus: 'suspended', changedAt: NOW });
		expect(await t.query(internal.seedDemo.sendingState.getDemoSendingState, {})).toEqual(
			suspended
		);

		const lifted = await t.mutation(internal.seedDemo.sendingState.setDemoSendingSuspended, {
			suspended: false,
		});
		expect(lifted).toMatchObject({ abuseStatus: 'clean' });
	});
});
