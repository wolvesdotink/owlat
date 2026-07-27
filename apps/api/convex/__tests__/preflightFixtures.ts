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
import type { Id } from '../_generated/dataModel';

export type TestRunner = ReturnType<typeof convexTest>;

/** UTC midnight — pins the retention horizon at exactly four usable days. */
export const MIDNIGHT = Date.UTC(2026, 6, 27, 0, 0, 0);

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The `vi.mock` factory for `../lib/sessionOrganization`. Imported dynamically
 * from inside the mock factory (which vitest hoists above every static import),
 * so the call site reads:
 *
 * ```ts
 * vi.mock('../lib/sessionOrganization', async () => {
 *   const { sessionOrganizationMock } = await import('./preflightFixtures');
 *   return await sessionOrganizationMock();
 * });
 * ```
 */
export async function sessionOrganizationMock(): Promise<Record<string, unknown>> {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
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
}

/**
 * Register the delivery-provider env and a frozen clock at `MIDNIGHT`. Call
 * once at the top level of a suite file.
 */
export function useMtaPreflightEnv(): void {
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
}

/** One warming IP row, with the noise fields filled in. */
export function warmingIp(overrides: {
	ip: string;
	phase: string;
	currentDay: number;
	dailyCap: number;
	sentToday?: number;
	pool?: string;
	active?: boolean;
}) {
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
	overrides: { totalSentToday?: number; syncedAt?: number; phase?: string } = {}
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

/** Alias kept for the regression suite's reading order. */
export const seedTightWarmingState = seedWarmingState;

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
