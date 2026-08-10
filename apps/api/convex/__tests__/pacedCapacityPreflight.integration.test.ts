/**
 * THE BINDING GATE READS THE DIAL — through its OWN entry point.
 *
 * `pacedWarmingCapacity.integration.test.ts` proves the shared loader and the
 * multi-day walker derive one projection. That is necessary and not sufficient:
 * the consumer whose refusal decides whether a campaign's tail expires in the
 * MTA queue is `campaigns/capacityPreflight.ts`, and "two callers of
 * `buildCapacitySchedule` agree" says nothing about whether the GATE reads the
 * dialed projection at all.
 *
 * So this suite asserts the pre-flight's own answer: `assessCampaignCapacity`
 * is called through its public entry point against a seeded retreat, and the
 * day count IT returns is compared with the day count the walker's capacity
 * produces. A gate that read the undialed projection would bless a five-day
 * plan the walker then takes seven days to run — which is the failure the
 * multi-day plan exists to prevent.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { modules } from './testModules';
import { assessCampaignCapacity } from '../campaigns/capacityPreflight';
import { buildCapacitySchedule } from '../campaigns/capacityPlan';
import { PACE_AIMD } from '../delivery/ramp/paceConfig';
import { DESTINATION_PROVIDER_KEYS } from '@owlat/shared/deliverabilityRouting';
import { createTestContact, createTestTopic } from './factories';
import {
	MIDNIGHT,
	seedWarmingState,
	useMtaPreflightEnv,
	type TestRunner,
} from './preflightFixtures';
import type { StoredAudience } from '../campaigns/audience';

vi.mock('../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_paced_preflight'),
	};
});

const ORG = 'org_paced_preflight';
/** Larger than everything the seeded schedule can carry inside the horizon. */
const AUDIENCE_SIZE = 600;

useMtaPreflightEnv();

/**
 * A retreated dial on every campaign cell — the half that reaches production.
 *
 * Iterates the WHOLE taxonomy (D8), not a copy of it: a sixth destination
 * provider has to be seeded and asserted here too, rather than leaving its
 * preflight path silently unexercised while the suite stays green.
 */
async function seedRetreatedDial(t: TestRunner): Promise<void> {
	await t.run(async (ctx) => {
		for (const destinationProvider of DESTINATION_PROVIDER_KEYS) {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: ORG,
				destinationProvider,
				stream: 'campaign' as const,
				isFallbackActive: false,
				signals: [],
				paceMultiplier: PACE_AIMD.multiplierFloor,
				snapshotGeneratedAt: MIDNIGHT,
				expiresAt: MIDNIGHT + 24 * 60 * 60 * 1000,
				updatedAt: MIDNIGHT,
			});
		}
	});
}

async function seedTopicAudience(t: TestRunner): Promise<StoredAudience> {
	return await t.run(async (ctx) => {
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		for (let i = 0; i < AUDIENCE_SIZE; i += 1) {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: `paced-${i}@subscriber.example.com`, doiStatus: 'confirmed' })
			);
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: MIDNIGHT });
		}
		return { kind: 'topic' as const, topicId };
	});
}

/** The pre-flight's OWN verdict, through the entry point production calls. */
async function assess(t: TestRunner, audience: StoredAudience) {
	return await t.run(async (ctx) => await assessCampaignCapacity(ctx, { audience, now: MIDNIGHT }));
}

describe('the binding capacity pre-flight reads the pace dial', () => {
	it('refuses on the DIALED projection, and sizes the same plan the walker will run', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const audience = await seedTopicAudience(t);

		// BEFORE: no dial at all. The gate refuses on the published schedule alone,
		// which is the shipped behaviour this piece must not change.
		const undialed = await assess(t, audience);
		expect(undialed.capacityKnown).toBe(true);
		expect(undialed.fits).toBe(false);
		if (undialed.capacityKnown !== true || undialed.fits !== false) return;

		await seedRetreatedDial(t);

		const dialed = await assess(t, audience);
		expect(dialed.capacityKnown).toBe(true);
		expect(dialed.fits).toBe(false);
		if (dialed.capacityKnown !== true || dialed.fits !== false) return;

		// THE GATE READ THE DIAL: a retreat can only ever lengthen the plan, and a
		// gate reading the undialed projection would have returned the same number
		// twice.
		expect(dialed.schedule.days).toBeGreaterThan(undialed.schedule.days);

		// AND IT SIZED THE PLAN THE WALKER WILL ACTUALLY RUN. The walker meters the
		// send day by day off `getSendPlanCapacity`; if the gate's day count and the
		// walker's disagree, a plan the gate blessed expires at its tail.
		const walker = await t.query(internal.campaigns.sendPlanQueries.getSendPlanCapacity, {
			audience,
			countAudienceSize: false,
		});
		const walkerDays = buildCapacitySchedule({
			audienceSize: AUDIENCE_SIZE,
			remainingCapacityByDay: walker.capacityByDay,
			now: MIDNIGHT,
		}).days;
		expect(dialed.schedule.days).toBe(walkerDays);
		expect(dialed.schedule.slices).toEqual(
			buildCapacitySchedule({
				audienceSize: AUDIENCE_SIZE,
				remainingCapacityByDay: walker.capacityByDay,
				now: MIDNIGHT,
			}).slices
		);
	});

	it('an UNDIALED deployment gets exactly the shipped verdict (D2)', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const audience = await seedTopicAudience(t);

		const assessment = await assess(t, audience);
		expect(assessment.capacityKnown).toBe(true);
		expect(assessment.fits).toBe(false);
		if (assessment.capacityKnown !== true || assessment.fits !== false) return;
		// 600 recipients against 0 / 100 / 200 / 200 / 700 — the shipped fixture in
		// preflightBinding.test.ts, unchanged by this piece.
		expect(assessment.schedule.days).toBe(5);
		expect(assessment.schedule.slices).toEqual([0, 100, 200, 200, 100]);
	});
});
