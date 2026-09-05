/**
 * SHARED FIXTURES for the capacity-ceiling suites (P3-3).
 *
 * The suites need the same things — a fixed clock, a warming state, a week of
 * cell traffic split across the two arms, a REAL warm-up-overflow route
 * configuration, and the capacity blob out of the audit row — and they must not
 * drift apart: the reroute suite asserts what the numbers MEAN, the regression
 * suite asserts which shipped absences still answer `unconstrained`, and a
 * fixture that disagreed between them would make one of the two lie.
 *
 * NOTHING HERE RE-IMPLEMENTS A PRODUCTION RULE. The day boundary is
 * `lib/clock.startOfDayUtc` and the day length is `lib/constants.DAY_MS`,
 * because a fixture that recomputes `x - (x % DAY)` for itself cannot catch a
 * bug in the arithmetic the projection actually uses. The capacity snapshot type
 * is `RampCapacityInput` itself rather than a loose restatement of it, so a
 * change to that union breaks these fixtures instead of leaving the suites
 * asserting a shape the controller no longer produces. And the arm a rerouted
 * send lands in comes from the shipped `armForTransport`, never from a literal.
 */

import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import type { Harness } from './rampCronFixtures';
import { ZERO_TRANSPORT_OUTCOME_TOTALS } from '../../analytics/transportOutcomeSummary';
import { armForTransport } from '../sendAssignments';
import { resolveSendRouteFromDb } from '../../lib/sendProviders/route';
import type { ResolvedRoute } from '../../lib/sendProviders/routing';
import type { RampCapacityInput } from '../ramp/controllerTypes';
import { createTestDomain } from '../../__tests__/factories';
import { startOfDayUtc } from '../../lib/clock';
import { DAY_MS } from '../../lib/constants';

export const CAPACITY_ORG = 'org_ramp_capacity';
/** 08:00 UTC on a fixed day: two thirds of the UTC day still ahead. */
export const CAPACITY_NOW = 1_800_000_000_000;
export const CAPACITY_TODAY = startOfDayUtc(CAPACITY_NOW);
export const CAPACITY_CELL = deliverabilityCellKey({
	stream: 'campaign',
	destinationProvider: 'gmail',
});

/** The From-domain the relay proof below is issued for. */
const CAPACITY_FROM_DOMAIN = 'ramp-capacity.example.com';
export const CAPACITY_FROM = `sender@${CAPACITY_FROM_DOMAIN}`;
/** A gmail recipient, so the resolved cell is `CAPACITY_CELL`. */
export const CAPACITY_TO = 'subscriber@gmail.com';

/**
 * The schema-parameterized convex-test runner, DEFINED ONCE in
 * `rampCronFixtures` and re-exported here so a capacity suite needs one import
 * rather than a third copy of the alias.
 */
export type { Harness } from './rampCronFixtures';

/**
 * The `capacity` member of a `mixDecisions` snapshot blob, DERIVED from the
 * controller's own type: the audit row is `JSON.stringify` of exactly this
 * value, so the round trip is structurally identical and restating it as loose
 * strings would let the union change under the suites without breaking them.
 */
export type CapacitySnapshot = RampCapacityInput;
export type ProjectedCapacity = Extract<RampCapacityInput, { kind: 'projected' }>;

/**
 * One day of the cell's traffic, split across the two arms exactly as the router
 * would have written it: the own arm gets what the MTA carried, the reference arm
 * gets the assigned relay traffic AND anything the warming cap rerouted.
 *
 * The two arm names are not literals — they come from the shipped
 * `armForTransport`, so a fixture can never file traffic under an arm the
 * production writer would not have used for that transport.
 */
export async function seedTrafficDay(
	t: Harness,
	args: { dayOffset: number; own: number; reference: number }
): Promise<void> {
	const periodStart = CAPACITY_TODAY - args.dayOffset * DAY_MS;
	await t.run(async (ctx) => {
		for (const [arm, sent] of [
			[armForTransport('mta'), args.own],
			[armForTransport('ses'), args.reference],
		] as const) {
			await ctx.db.insert('transportOutcomes', {
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				organizationId: CAPACITY_ORG,
				cell: CAPACITY_CELL,
				arm,
				periodStart,
				shardKey: 0,
				sent,
				delivered: sent,
				lastRecordedAt: periodStart + DAY_MS - 1,
			});
		}
	});
}

export interface SeedWarmingOptions {
	/** Overall pool phase; `'graduated'` is the shipped "no cap at all" answer. */
	readonly phase?: 'ramp' | 'plateau' | 'graduated';
	/** How long before the fixed clock the MTA last synced. */
	readonly syncedAgoMs?: number;
	readonly dailyCap?: number;
	readonly sentToday?: number;
}

/** One active campaign IP, with headroom left today unless told otherwise. */
export async function seedWarming(t: Harness, options: SeedWarmingOptions = {}): Promise<void> {
	const phase = options.phase ?? 'ramp';
	const dailyCap = options.dailyCap ?? 5000;
	const sentToday = options.sentToday ?? 1000;
	await t.run(async (ctx) => {
		await ctx.db.insert('warmingState', {
			phase,
			totalDailyCap: dailyCap,
			totalSentToday: sentToday,
			ipCount: 1,
			ips: [
				{
					ip: '203.0.113.20',
					phase,
					currentDay: 8,
					dailyCap,
					sentToday,
					bounceRate: 0,
					deferralRate: 0,
					pool: 'campaign',
					active: true,
				},
			],
			syncedAt: CAPACITY_NOW - (options.syncedAgoMs ?? 60_000),
		});
	});
}

/** Spend the pool's whole daily cap, so the shipped overflow gate actually binds. */
export async function spendWarmingCap(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		const state = await ctx.db.query('warmingState').first();
		if (!state) throw new Error('warming state must be seeded before it can be spent');
		await ctx.db.patch(state._id, {
			totalSentToday: state.totalDailyCap,
			ips: state.ips.map((ip) => ({ ...ip, sentToday: ip.dailyCap })),
		});
	});
}

/** Put the pool's headroom back, so a later tick has a real ceiling to compute. */
export async function refillWarmingCap(t: Harness, sentToday = 1000): Promise<void> {
	await t.run(async (ctx) => {
		const state = await ctx.db.query('warmingState').first();
		if (!state) throw new Error('warming state must be seeded before it can be refilled');
		await ctx.db.patch(state._id, {
			totalSentToday: sentToday,
			ips: state.ips.map((ip) => ({ ...ip, sentToday })),
		});
	});
}

/**
 * The credentials BOTH arms need to be READY routes.
 *
 * Enabled is not ready: `resolveRoute` filters route entries through
 * `isSendProviderReady`, which requires each kind's `requiredEnvVars`
 * (`lib/sendProviders/catalog.ts`). Without these the own-MTA entry is not a
 * route and the relay entry is not a relay, and the overflow suites would pass
 * or fail for a reason that has nothing to do with the warming cap.
 */
const TRANSPORT_ENV: Readonly<Record<string, string>> = {
	MTA_API_URL: 'http://mta:3100',
	MTA_API_KEY: 'test-key',
	AWS_SES_REGION: 'us-east-1',
	AWS_SES_ACCESS_KEY_ID: 'test-access-key-id',
	AWS_SES_SECRET_ACCESS_KEY: 'test-secret-access-key',
};

function configureRelayEnv(): void {
	for (const [key, value] of Object.entries(TRANSPORT_ENV)) process.env[key] = value;
}

export function clearRelayEnv(): void {
	for (const key of Object.keys(TRANSPORT_ENV)) delete process.env[key];
}

/**
 * THE SHIPPED WARM-UP-OVERFLOW CONFIGURATION, end to end: an own-MTA campaign
 * route with an enabled, credentialed, domain-verified SES relay behind it and
 * `isWarmupOverflowEnabled` set. Those are every link the shipped resolver
 * requires before it will relay instead of deferring — absent any one of them
 * the cap simply binds, which is the shipped behaviour and not the composition
 * these suites measure.
 */
export async function seedOverflowRoute(t: Harness): Promise<void> {
	configureRelayEnv();
	await t.run(async (ctx) => {
		const tokens = ['one', 'two', 'three'];
		const domainId = await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: CAPACITY_FROM_DOMAIN,
				status: 'verified',
				providerType: 'mta',
				lastVerifiedAt: CAPACITY_NOW,
			})
		);
		await ctx.db.insert('sendingDomainSesIdentities', {
			domainId,
			dkimTokens: tokens,
			verificationToken: 'verified-token',
			dnsRecords: {
				spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
				dkim: tokens.map((token) => ({
					type: 'CNAME' as const,
					host: `${token}._domainkey`,
					value: `${token}.dkim.amazonses.com`,
				})),
				mailFrom: [
					{ type: 'MX' as const, host: 'mail', value: 'feedback-smtp.example.com', priority: 10 },
					{ type: 'TXT' as const, host: 'mail', value: 'v=spf1 include:amazonses.com ~all' },
				],
			},
			verificationResults: {
				spf: { verified: true, lastChecked: CAPACITY_NOW },
				dkim: tokens.map(() => ({ verified: true, lastChecked: CAPACITY_NOW })),
				mailFrom: [
					{ verified: true, lastChecked: CAPACITY_NOW },
					{ verified: true, lastChecked: CAPACITY_NOW },
				],
				sesStatus: 'Success',
			},
			isProviderVerified: true,
			verifiedAt: CAPACITY_NOW,
			createdAt: CAPACITY_NOW,
			updatedAt: CAPACITY_NOW,
		});
		await ctx.db.insert('providerRoutes', {
			messageType: 'campaign',
			strategy: 'priority_failover',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			ipPool: 'campaign',
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'ses',
				isWarmupOverflowEnabled: true,
			},
			createdAt: CAPACITY_NOW,
			updatedAt: CAPACITY_NOW,
		});
	});
}

/**
 * RUN THE SHIPPED RESOLVER for one campaign recipient. This is the production
 * entry point every governed campaign send goes through — no re-derivation, no
 * stand-in — so what it answers here is what the router answers in production
 * for the state the fixture just seeded.
 */
export async function resolveShippedRoute(
	t: Harness,
	options: { forceRelayReason?: 'warmup_overflow' | 'breaker_open' } = {}
): Promise<ResolvedRoute | null> {
	return await t.run(
		async (ctx) =>
			await resolveSendRouteFromDb(ctx, 'campaign', {
				to: CAPACITY_TO,
				from: CAPACITY_FROM,
				...(options.forceRelayReason ? { forceRelayReason: options.forceRelayReason } : {}),
			})
	);
}

/** The capacity blob the controller actually decided against, off the audit row. */
export async function capacityFor(t: Harness): Promise<CapacitySnapshot> {
	const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
	const row = rows.find((decision) => decision.cell === CAPACITY_CELL);
	if (!row) throw new Error('no decision recorded for the cell');
	const snapshot = JSON.parse(String(row.snapshot)) as { capacity: CapacitySnapshot };
	return snapshot.capacity;
}

/** The same blob, narrowed — a suite asserting the arithmetic wants the numbers. */
export async function projectedCapacityFor(t: Harness): Promise<ProjectedCapacity> {
	const capacity = await capacityFor(t);
	if (capacity.kind !== 'projected') {
		throw new Error(`expected a projected capacity reading, got ${capacity.kind}`);
	}
	return capacity;
}

/** Seven complete days at a fixed demand of 1000 sends a day, split by `ownPerDay`. */
export async function seedTrafficWeek(t: Harness, ownPerDay: number): Promise<void> {
	for (let dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
		await seedTrafficDay(t, { dayOffset, own: ownPerDay, reference: 1000 - ownPerDay });
	}
}
