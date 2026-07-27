/**
 * `analytics.reputationQueries.getCampaignSendEstimate` — the ADVISORY readout
 * the campaign wizard renders ("this campaign will take approximately N days").
 *
 * P0-5 repointed it at the published warming schedule so the advisory estimate
 * and the BINDING pre-flight refusal can never tell the operator two different
 * stories. That is a change to shipped behaviour, and the query had no tests at
 * all, so every branch is pinned here (D19: divergences are fixture-pinned or
 * they are defects).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import {
	MIDNIGHT,
	useMtaPreflightEnv,
	warmingIp,
	type TestRunner,
	type WarmingIpRow,
	type WarmingPhase,
} from './preflightFixtures';
import { MAX_PLAN_DAYS } from '../campaigns/capacityPlan';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock } = await import('./sessionOrganizationMock');
	return await sessionOrganizationMock();
});

const modules = import.meta.glob('../**/*.*s');

useMtaPreflightEnv();

/** One active campaign IP, with the deployment totals stated explicitly. */
async function seedWarming(
	t: TestRunner,
	opts: {
		phase: WarmingPhase;
		/** Deployment roll-up — counts EVERY campaign-pool IP, `active` or not. */
		totalDailyCap: number;
		totalSentToday: number;
		/** The primary IP's own cap. Defaults to the roll-up (one-IP deployments). */
		ipDailyCap?: number;
		ipSentToday?: number;
		currentDay: number;
		syncedAt?: number;
		extraIps?: WarmingIpRow[];
	}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('warmingState', {
			phase: opts.phase,
			totalDailyCap: opts.totalDailyCap,
			totalSentToday: opts.totalSentToday,
			ipCount: 1 + (opts.extraIps?.length ?? 0),
			ips: [
				warmingIp({
					ip: '203.0.113.10',
					phase: opts.phase,
					currentDay: opts.currentDay,
					dailyCap: opts.ipDailyCap ?? opts.totalDailyCap,
					sentToday: opts.ipSentToday ?? opts.totalSentToday,
				}),
				...(opts.extraIps ?? []),
			],
			syncedAt: opts.syncedAt ?? MIDNIGHT,
		});
	});
}

describe('getCampaignSendEstimate — terminal branches', () => {
	it('reports "not available yet" when no warming state has ever synced', async () => {
		const t = convexTest(schema, modules);

		const estimate = await t.query(api.analytics.reputationQueries.getCampaignSendEstimate, {
			recipientCount: 5_000,
		});

		expect(estimate).toEqual({
			totalDailyCap: 0,
			remainingToday: 0,
			estimatedDays: 1,
			isFullyWarmed: false,
			message: 'Warming data not available yet. Your emails will be paced automatically.',
		});
	});

	it('reports full speed once the deployment has graduated', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t, {
			phase: 'graduated',
			totalDailyCap: 200_000,
			totalSentToday: 0,
			currentDay: 90,
		});

		const estimate = await t.query(api.analytics.reputationQueries.getCampaignSendEstimate, {
			recipientCount: 1_000_000,
		});

		expect(estimate.isFullyWarmed).toBe(true);
		expect(estimate.estimatedDays).toBe(1);
		expect(estimate.message).toContain('fully warmed');
	});

	/**
	 * Warming state EXISTS and `totalDailyCap` is non-zero, but the projection
	 * cannot be built (here: the MTA sync stopped). The estimate falls back to
	 * the shipped "paced automatically" copy rather than inventing a day count.
	 */
	it('falls back to the paced-automatically copy when capacity cannot be projected', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t, {
			phase: 'ramp',
			totalDailyCap: 100,
			totalSentToday: 100,
			currentDay: 1,
			syncedAt: MIDNIGHT - 3 * 24 * 60 * 60 * 1000,
		});

		const estimate = await t.query(api.analytics.reputationQueries.getCampaignSendEstimate, {
			recipientCount: 600,
		});

		expect(estimate.totalDailyCap).toBe(100);
		expect(estimate.remainingToday).toBe(0);
		expect(estimate.estimatedDays).toBe(1);
		expect(estimate.isFullyWarmed).toBe(false);
		expect(estimate.message).toBe(
			'Warming data not available yet. Your emails will be paced automatically.'
		);
	});

	/** A mixed graduated + ramping pool is unbounded, so it takes the same path. */
	it('falls back to the paced-automatically copy on a mixed graduated pool', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t, {
			phase: 'ramp',
			totalDailyCap: 100,
			totalSentToday: 100,
			currentDay: 1,
			extraIps: [
				warmingIp({ ip: '203.0.113.20', phase: 'graduated', currentDay: 90, dailyCap: 200_000 }),
			],
		});

		const estimate = await t.query(api.analytics.reputationQueries.getCampaignSendEstimate, {
			recipientCount: 600,
		});

		expect(estimate.estimatedDays).toBe(1);
		expect(estimate.message).toBe(
			'Warming data not available yet. Your emails will be paced automatically.'
		);
	});
});

describe('getCampaignSendEstimate — day counts', () => {
	it('reports one day when the campaign fits inside today’s remainder', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t, {
			phase: 'ramp',
			totalDailyCap: 1_000,
			totalSentToday: 0,
			currentDay: 5,
		});

		const estimate = await t.query(api.analytics.reputationQueries.getCampaignSendEstimate, {
			recipientCount: 500,
		});

		expect(estimate.remainingToday).toBe(1_000);
		expect(estimate.estimatedDays).toBe(1);
		expect(estimate.message).toContain("fits within today's remaining capacity");
	});

	/**
	 * A day-1 IP with today's cap spent projects 0 / 100 / 200 / 200 / 700 …, so
	 * 600 recipients land on the fifth calendar day — the SAME schedule the
	 * binding gate refuses with. The two must never disagree.
	 */
	it('projects a multi-day count off the published warming schedule', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t, {
			phase: 'ramp',
			totalDailyCap: 50,
			totalSentToday: 50,
			currentDay: 1,
		});

		const estimate = await t.query(api.analytics.reputationQueries.getCampaignSendEstimate, {
			recipientCount: 600,
		});

		expect(estimate.estimatedDays).toBe(5);
		expect(estimate.message).toBe(
			'Based on your IP warmup progress, this campaign will take approximately 5 days to complete.'
		);
	});

	/**
	 * The advisory readout and the BINDING gate must count the same IPs.
	 * `warmingState.totalDailyCap` / `totalSentToday` roll up every campaign-pool
	 * IP regardless of `active` (packages/shared/src/ipReadinessSync.ts), so
	 * deriving today's remainder from them let a DEACTIVATED 100,000-cap IP make
	 * this query answer "fits within today's remaining capacity (100,050 emails)"
	 * about the very campaign the gate refuses as a five-day schedule
	 * (preflightBinding.test.ts, "does not count a deactivated campaign IP").
	 * Both now read the ACTIVE campaign-IP sum out of `warmingCapacity.ts`.
	 */
	it('ignores a deactivated campaign IP when sizing today’s remainder', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t, {
			phase: 'ramp',
			totalDailyCap: 100_050,
			totalSentToday: 50,
			ipDailyCap: 50,
			ipSentToday: 50,
			currentDay: 1,
			extraIps: [
				warmingIp({
					ip: '203.0.113.40',
					phase: 'ramp',
					currentDay: 12,
					dailyCap: 100_000,
					active: false,
				}),
			],
		});

		const estimate = await t.query(api.analytics.reputationQueries.getCampaignSendEstimate, {
			recipientCount: 600,
		});

		// The deployment roll-up is still the roll-up (a display field) …
		expect(estimate.totalDailyCap).toBe(100_050);
		// … but the remainder — the number the fits-today short-circuit turns on —
		// counts only the active day-1 IP, whose cap is already spent.
		expect(estimate.remainingToday).toBe(0);
		expect(estimate.estimatedDays).toBe(5);
		expect(estimate.message).toBe(
			'Based on your IP warmup progress, this campaign will take approximately 5 days to complete.'
		);
	});

	it('says "60+ days" instead of quoting a truncated schedule as a finish date', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t, {
			phase: 'ramp',
			totalDailyCap: 50,
			totalSentToday: 50,
			currentDay: 1,
		});

		const estimate = await t.query(api.analytics.reputationQueries.getCampaignSendEstimate, {
			recipientCount: 50_000_000,
		});

		expect(estimate.estimatedDays).toBe(MAX_PLAN_DAYS);
		expect(estimate.message).toBe(
			`Campaign will take approximately ${MAX_PLAN_DAYS}+ days based on current warmup progress.`
		);
	});
});
