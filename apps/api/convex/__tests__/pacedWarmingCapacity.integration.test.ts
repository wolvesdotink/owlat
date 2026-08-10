/**
 * ONE PROJECTION, ONE POPULATION, ONE ANSWER — with the pace dial applied.
 *
 * Three consumers read the campaign warming projection and all three have to
 * agree, because they are three views of one fact: the BINDING capacity
 * pre-flight (which refuses a send it can prove will not finish inside the
 * retention horizon), the multi-day walker's day budget (which actually meters
 * the send), and the operator-facing send estimate.
 *
 * Dialing only the walker breaks that in the UNSAFE direction: a retreated dial
 * makes the walk take several times as many days as the pre-flight sized it for,
 * so a plan the gate blessed expires at its tail — precisely the failure the
 * multi-day plan exists to prevent. This suite asserts they cannot diverge.
 *
 * The dial's RETREAT half is what reaches this projection by design (see
 * `applyPaceToCapacityByDay`), so the fixtures retreat it.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { modules } from './testModules';
import { loadPacedWarmingCapacity } from '../delivery/pacedWarmingCapacity';
import { loadWarmingCapacity } from '../delivery/warmingCapacity';
import { buildCapacitySchedule } from '../campaigns/capacityPlan';
import { PACE_AIMD } from '../delivery/ramp/paceConfig';
import { DESTINATION_PROVIDER_KEYS } from '@owlat/shared/deliverabilityRouting';
import type { StoredAudience } from '../campaigns/audience';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_paced_capacity'),
	};
});

const ORG = 'org_paced_capacity';
const DAILY_CAP = 400;

type Harness = ReturnType<typeof convexTest>;

async function seedWarming(t: Harness): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('warmingState', {
			phase: 'ramp',
			totalDailyCap: DAILY_CAP,
			totalSentToday: 0,
			ipCount: 1,
			ips: [
				{
					ip: '203.0.113.10',
					phase: 'ramp',
					currentDay: 1,
					dailyCap: DAILY_CAP,
					sentToday: 0,
					bounceRate: 0,
					deferralRate: 0,
					pool: 'campaign',
					active: true,
				},
			],
			syncedAt: now,
		});
	});
}

/**
 * A retreated dial on every campaign cell — the half that reaches production.
 *
 * Iterates the WHOLE taxonomy (D8), not a copy of it: a sixth destination
 * provider has to be seeded and asserted here too, rather than leaving its
 * paced-capacity path silently unexercised while the suite stays green.
 */
async function seedRetreatedDial(t: Harness, multiplier: number): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		for (const destinationProvider of DESTINATION_PROVIDER_KEYS) {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider,
				stream: 'campaign' as const,
				isFallbackActive: false,
				signals: [],
				paceMultiplier: multiplier,
				snapshotGeneratedAt: now,
				expiresAt: now + 24 * 60 * 60 * 1000,
				updatedAt: now,
			});
		}
	});
}

/** A topic audience the walker's capacity query accepts. */
async function seedAudience(t: Harness): Promise<StoredAudience> {
	const now = Date.now();
	const topicId = await t.run(async (ctx) => {
		return await ctx.db.insert('topics', {
			name: 'paced',
			requireDoubleOptIn: false,
			createdAt: now,
			updatedAt: now,
		});
	});
	return { kind: 'topic', topicId: topicId as Id<'topics'> };
}

describe('the pace dial reaches every campaign-facing consumer, or none', () => {
	it('the walker reads exactly the projection the shared loader derives', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t);
		await seedRetreatedDial(t, PACE_AIMD.multiplierFloor);
		const audience = await seedAudience(t);

		const shared = await t.run(
			async (ctx) => await loadPacedWarmingCapacity(ctx, { now: Date.now() })
		);
		const walker = await t.query(internal.campaigns.sendPlanQueries.getSendPlanCapacity, {
			audience,
			countAudienceSize: false,
		});

		expect(shared).not.toBeNull();
		expect(walker.capacityByDay).toEqual(shared?.byDay);
	});

	// THE PROJECTION-LEVEL HALF of the agreement: the dialed projection lengthens
	// the plan, and the walker's capacity produces the same length. The BINDING
	// gate's own entry point is asserted separately, in
	// `pacedCapacityPreflight.integration.test.ts`, because "two callers of
	// `buildCapacitySchedule` agree" cannot tell you whether
	// `campaigns/capacityPreflight.ts` reads the dialed projection at all.
	it('a retreated dial lengthens the projection, and the walker reads the same one', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t);
		const audience = await seedAudience(t);
		const audienceSize = 2_000;

		const undialed = await t.run(
			async (ctx) => await loadWarmingCapacity(ctx, { now: Date.now() })
		);
		const undialedDays = buildCapacitySchedule({
			audienceSize,
			remainingCapacityByDay: undialed?.byDay ?? [],
			now: Date.now(),
		}).days;

		await seedRetreatedDial(t, PACE_AIMD.multiplierFloor);
		const dialed = await t.run(
			async (ctx) => await loadPacedWarmingCapacity(ctx, { now: Date.now() })
		);
		const walker = await t.query(internal.campaigns.sendPlanQueries.getSendPlanCapacity, {
			audience,
			countAudienceSize: false,
		});

		// ONE PROJECTION, ONE LENGTH. Both sides go through
		// `loadPacedWarmingCapacity`, so the day count derived from the shared loader
		// is the day count the walker will actually take.
		const dialedDays = buildCapacitySchedule({
			audienceSize,
			remainingCapacityByDay: dialed?.byDay ?? [],
			now: Date.now(),
		}).days;
		const walkerDays = buildCapacitySchedule({
			audienceSize,
			remainingCapacityByDay: walker.capacityByDay,
			now: Date.now(),
		}).days;
		expect(walkerDays).toBe(dialedDays);
		// And the dial genuinely moved the answer, so the assertion above is not
		// two identical undialed numbers agreeing with each other.
		expect(dialedDays).toBeGreaterThan(undialedDays);
	});

	it('BOTH halves of the projection are dialed, not just the per-day array', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t);
		await seedRetreatedDial(t, PACE_AIMD.multiplierFloor);

		const undialed = await t.run(
			async (ctx) => await loadWarmingCapacity(ctx, { now: Date.now() })
		);
		const dialed = await t.run(
			async (ctx) => await loadPacedWarmingCapacity(ctx, { now: Date.now() })
		);
		// "Fits today" and "takes four days" are two questions about one
		// population; dialing one and not the other is how they describe different
		// deployments.
		expect(dialed?.remainingToday).toBeLessThan(undialed?.remainingToday ?? 0);
		expect(dialed?.remainingToday).toBe(dialed?.byDay[0]);
	});

	it('NO dial at all leaves the projection exactly as the shipped one (D2)', async () => {
		const t = convexTest(schema, modules);
		await seedWarming(t);

		const undialed = await t.run(
			async (ctx) => await loadWarmingCapacity(ctx, { now: Date.now() })
		);
		const dialed = await t.run(
			async (ctx) => await loadPacedWarmingCapacity(ctx, { now: Date.now() })
		);
		expect(dialed).toEqual(undialed);
	});

	it('no warming projection stays no projection — the dial never invents one', async () => {
		const t = convexTest(schema, modules);
		await seedRetreatedDial(t, PACE_AIMD.multiplierFloor);

		const dialed = await t.run(
			async (ctx) => await loadPacedWarmingCapacity(ctx, { now: Date.now() })
		);
		expect(dialed).toBeNull();
	});
});
