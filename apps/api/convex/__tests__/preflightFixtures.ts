/**
 * Shared fixtures for the P0-5 pre-flight suites (`preflightBinding`,
 * `preflightRegression`, `campaignSendEstimate`). The session mock, the
 * delivery-provider env and the warming-state seeds were duplicated
 * near-verbatim across them; one copy here keeps the three from drifting.
 */

import { beforeEach, afterEach, vi } from 'vitest';
import type { convexTest } from 'convex-test';
import {
	validateReadyToSend,
	type PreflightOptions,
	type PreflightResult,
} from '../campaigns/preflight';
import type { Doc, Id } from '../_generated/dataModel';

export type TestRunner = ReturnType<typeof convexTest>;

/** UTC midnight — pins the retention horizon at exactly four usable days. */
export const MIDNIGHT = Date.UTC(2026, 6, 27, 0, 0, 0);

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Register the delivery-provider env and a frozen clock at `MIDNIGHT`. Call
 * once at the top level of a suite file.
 *
 * ONLY `Date` is faked. These suites need a frozen clock (the queries under
 * test read `Date.now()`) and never advance timers, but the default
 * `useFakeTimers()` also replaces `setTimeout`/`setInterval`/`setImmediate` for
 * the whole file — and `convex-test` yields to the macrotask queue while
 * walking a large table, so a seeded audience of a few thousand rows waits
 * forever on a timer nothing will ever fire. The suites still passed while the
 * fixtures were small, which is exactly how this hid.
 */
export function useMtaPreflightEnv(): void {
	beforeEach(() => {
		process.env['EMAIL_PROVIDER'] = 'mta';
		process.env['MTA_API_URL'] = 'http://mta:3100';
		process.env['MTA_API_KEY'] = 'test-key';
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(MIDNIGHT);
	});

	afterEach(() => {
		vi.useRealTimers();
		delete process.env['EMAIL_PROVIDER'];
		delete process.env['MTA_API_URL'];
		delete process.env['MTA_API_KEY'];
	});
}

/** One entry of `warmingState.ips` — anchored to the schema row itself. */
export type WarmingIpRow = Doc<'warmingState'>['ips'][number];

/**
 * The values `phase` and `pool` may actually take. The schema stores both as
 * `v.string()` (the MTA sync is the writer), so nothing downstream of the
 * schema stops a fixture from writing `pool: 'campaigns'` — which would make
 * every seeded IP non-campaign, silently empty the projection's population, and
 * leave the assertions passing for the wrong reason. Narrow them HERE, where the
 * fixtures are written, so that typo is a compile error.
 */
export type WarmingPhase = 'ramp' | 'plateau' | 'graduated';
export type WarmingIpPool = 'campaign' | 'transactional';

/**
 * One warming IP row, with the noise fields filled in. The return type is the
 * schema row, so a schema change breaks the fixture instead of the suites.
 */
export function warmingIp(overrides: {
	ip: string;
	phase: WarmingPhase;
	currentDay: number;
	dailyCap: number;
	sentToday?: number;
	pool?: WarmingIpPool;
	active?: boolean;
}): WarmingIpRow {
	return {
		ip: overrides.ip,
		phase: overrides.phase,
		currentDay: overrides.currentDay,
		dailyCap: overrides.dailyCap,
		sentToday: overrides.sentToday ?? 0,
		bounceRate: 0,
		deferralRate: 0,
		pool: overrides.pool ?? 'campaign',
		active: overrides.active ?? true,
	};
}

/**
 * One active, day-1 warming IP whose whole daily cap is already spent.
 * Projected capacity across the four-day retention horizon is
 * 0 (today) + 100 + 200 + 200 = 500.
 */
export async function seedWarmingState(
	t: TestRunner,
	overrides: { totalSentToday?: number; syncedAt?: number; phase?: WarmingPhase } = {}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('warmingState', {
			phase: overrides.phase ?? 'ramp',
			totalDailyCap: 50,
			totalSentToday: overrides.totalSentToday ?? 50,
			ipCount: 1,
			ips: [
				warmingIp({
					ip: '203.0.113.10',
					phase: overrides.phase ?? 'ramp',
					currentDay: 1,
					dailyCap: 50,
					sentToday: overrides.totalSentToday ?? 50,
				}),
			],
			syncedAt: overrides.syncedAt ?? MIDNIGHT,
		});
	});
}

/**
 * Run the real pre-flight against a stored campaign with the BINDING capacity
 * gate enabled. `validateReadyToSendQuery` deliberately disables it (a
 * capacity refusal at fire time has no consumer), so a suite that wants to
 * prove the gate's ordering has to go through `validateReadyToSend` directly.
 */
export async function runPreflight(
	t: TestRunner,
	campaignId: Id<'campaigns'>,
	options: PreflightOptions = {}
): Promise<PreflightResult> {
	return await t.run(async (ctx): Promise<PreflightResult> => {
		const campaign = await ctx.db.get(campaignId);
		if (!campaign) return { ok: false, reason: 'not_found', message: 'Campaign not found' };
		return await validateReadyToSend(ctx, campaign, { now: MIDNIGHT, ...options });
	});
}
