/**
 * P0-5 — the capacity gate under `adaptive_mix`: the mix splits the audience
 * across the own arm and the reference transport, and the env var alone does
 * not. Both directions of that reading do real damage, so the same audience
 * is assessed under each route shape.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import {
	configureSesEnv,
	MIDNIGHT,
	runPreflight,
	seedCampaignCellShares,
	seedCampaignRoute,
	seedWarmingState,
	assessCampaign,
	seedSendableCampaign,
	useMtaPreflightEnv,
} from './preflightFixtures';
import { buildCapacitySchedule } from '../campaigns/capacityPlan';
import { planTodaysSlice } from '../campaigns/multiDaySendPlan';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock, MOCK_SINGLETON_ORG } = await import('./sessionOrganizationMock');
	return {
		...(await sessionOrganizationMock()),
		// The ramp cells the `adaptive_mix` suite seeds belong to a tenant, and the
		// warming-cap gate resolves it exactly the way the dispatch path does.
		getSingletonOrganizationId: vi.fn().mockResolvedValue(MOCK_SINGLETON_ORG),
	};
});

const modules = import.meta.glob('../**/*.*s');

useMtaPreflightEnv();

/**
 * A SPLIT ROUTE IS JUDGED ON THE OWN ARM'S SHARE — and never on `EMAIL_PROVIDER`.
 *
 * `adaptive_mix` decides per recipient, and this gate has a whole audience and
 * no recipient: the strategy therefore returns null, the resolver falls through
 * to the env default, and a verdict read off that base route is a verdict read
 * off an env var. Both directions of that reading do real damage, and the same
 * 600-recipient audience against the same day-1 IP pins both.
 */
describe('pre-flight capacity gate — adaptive_mix splits the audience, the env does not', () => {
	it('refuses the unfinishable own-arm campaign even when EMAIL_PROVIDER names the relay', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		// The relay is configured and ready, but no cell has been ramped onto it:
		// every recipient is still on the capped MTA. Reading `EMAIL_PROVIDER`
		// here let exactly this campaign through, to expire its tail in the queue.
		process.env['EMAIL_PROVIDER'] = 'ses';
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
		expect(result.capacityPlan?.days).toBe(5);
	});

	it('measures a half-relayed campaign against the half that meets the cap', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		process.env['EMAIL_PROVIDER'] = 'ses';
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});
		await seedCampaignCellShares(t, 0.5);

		// 300 own-arm messages against 500 of horizon capacity: it fits, and it
		// fits MEASURABLY — `capacityKnown: true` is what separates this from the
		// old "the env says SES, so nothing is known" pass.
		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: true, fits: true });
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	it('never quotes a multi-day plan to a 95%-relayed campaign', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		// `EMAIL_PROVIDER` is the own MTA (the suite default), which is what used
		// to refuse this send over five days — for the 30 messages the own arm
		// actually carries, all of which fit today.
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});
		await seedCampaignCellShares(t, 0.05);

		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: true, fits: true });
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	/**
	 * THE SHARE SCALING STOPS AT THE GATE, and that is pinned rather than implied.
	 *
	 * The pre-flight measures own-arm volume; the walker's day budget and the
	 * wizard's estimate meter the WHOLE audience against the same paced
	 * projection. On the same 5% fixture the gate says "fits" and both of those
	 * say five days — the walker because it really does pace all 600 recipients
	 * through the day budget, the estimate because it quotes what the walker will
	 * do. Nothing here is a defect the gate introduced (its scaling only ever
	 * ALLOWS more, so the cost is an over-long plan, never an expired tail), but
	 * it is a divergence an operator can see on one screen, so the two answers
	 * this build gives are written down. `campaigns/sendPlanQueries.ts` says which
	 * is authoritative and what would close it; if that lands, this test changes.
	 */
	it('leaves the walker and the estimate metering the whole audience', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});
		await seedCampaignCellShares(t, 0.05);

		// The gate: 30 own-arm messages against 500 of horizon capacity.
		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: true, fits: true });

		// The advisory readout the campaign editor renders beside it: 600 against
		// the same 0 / 100 / 200 / 200 / 700 projection.
		const estimate = await t.query(api.analytics.reputationQueries.getCampaignSendEstimate, {
			recipientCount: 600,
		});
		expect(estimate.estimatedDays).toBe(5);

		// And the actuator, which is what the operator will actually watch happen.
		const audience = await t.run(async (ctx) => (await ctx.db.get(campaignId))?.audience);
		if (!audience) throw new Error('campaign missing its audience');
		const capacity = await t.query(internal.campaigns.sendPlanQueries.getSendPlanCapacity, {
			audience,
			countAudienceSize: true,
		});
		expect(capacity.plannedTotal).toBe(600);
		if (capacity.plannedTotal === null) throw new Error('the walk counted no denominator');
		const slice = planTodaysSlice({
			state: {
				planDayKey: undefined,
				enqueuedToday: undefined,
				planDayIndex: undefined,
				planTotalDays: undefined,
				isPlanTruncated: undefined,
				plannedTotal: undefined,
				isPlannedTotalLowerBound: undefined,
			},
			remaining: { kind: 'exact', count: capacity.plannedTotal },
			capacityByDay: capacity.capacityByDay,
			now: MIDNIGHT,
		});
		expect(slice.totalDays).toBe(5);
	});

	it('holds and allows when the mix leaves the own arm carrying nothing', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});
		await seedCampaignCellShares(t, 0);

		expect(await assessCampaign(t, campaignId)).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'not_own_mta',
		});
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	/**
	 * A HETEROGENEOUS MIX IS THE RAMP'S STEADY STATE — the controller writes a
	 * share PER CELL — and it is the configuration where the floor and the peak
	 * stop being the same number. Every uniform fixture above is blind to the
	 * difference.
	 */
	it('does not claim a campaign fits when only its LOWEST-share cell says so', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});
		// Gmail is 95% relayed; every other cell is still entirely on the own MTA.
		// An audience with no gmail addresses in it puts all 600 messages on the
		// capped arm — 500 of horizon capacity — so scaling by the floor (0.05)
		// and calling the resulting 30 a measurement would bless exactly the
		// tail-expiry this gate exists to prevent.
		await seedCampaignCellShares(t, 1, { gmail: 0.05 });

		expect(await assessCampaign(t, campaignId)).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'mix_composition_unknown',
		});
		// Unmeasured still ALLOWS: refusing on the peak would block the audience
		// that really is 95% gmail, which fits in a single day (D2).
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	it('still measures a heterogeneous mix whose HIGHEST-share cell fits', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});
		// Peak 0.5: however this audience falls across the cells, at most 300 of
		// the 600 meet the cap and 500 fit inside the horizon. Composition it does
		// not know cannot make this campaign not fit, so it is measured, not held.
		await seedCampaignCellShares(t, 0.5, { gmail: 0.05 });

		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: true, fits: true });
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	/**
	 * A cell whose fallback is fully engaged (share 0) is ordinary in a ramping
	 * deployment, and it drives the stream's floor to zero — which is why this
	 * seam can never REFUSE such a campaign (see the `warmingCapGate` module
	 * doc). The peak is what keeps the other half of the answer honest: a
	 * campaign that fits at the peak is measured rather than waved through as
	 * "nothing is known".
	 */
	it('measures a campaign against the peak when one cell is fully relayed', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});
		await seedCampaignCellShares(t, 0.5, { gmail: 0 });

		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: true, fits: true });
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	/**
	 * The refusal side of a heterogeneous mix. The DECISION is enumerated over
	 * `floor x audience` — the volume the own arm is guaranteed to carry — but the
	 * plan handed to the operator is the walk: all 600 recipients, because that is
	 * what the walker paces and what the copy calls them. Composition the gate
	 * cannot know changes whether the cap can strand this campaign; it changes
	 * nothing about how long the send takes, so there is nothing to hedge (D14).
	 */
	it('decides a refusal on the floor and quotes the walk it will run', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});
		// Floor 0.9, peak 1: even the guaranteed 540 own-arm messages overrun the
		// 500 the horizon carries, so the refusal is sound.
		await seedCampaignCellShares(t, 1, { gmail: 0.9 });

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
		// 600 recipients, never the 540 messages the verdict was decided on.
		expect(result.capacityPlan?.covered).toBe(600);
		expect(result.capacityPlan?.slices).toEqual([0, 100, 200, 200, 100]);
		expect(result.capacityPlan?.audienceUnderCounted).toBe(false);
		expect(result.message).toContain('about 5 days');
	});

	/**
	 * THE UNHEDGED HOLE, and the reason this is not a cosmetic fix: at a UNIFORM
	 * fractional share the floor and the peak are the same number, so nothing
	 * marks the plan as a bound — the refusal quotes a finish date outright. Built
	 * over own-arm messages that date is one the walker cannot keep: 1,400
	 * recipients at a half share are 700 messages, which the projection clears a
	 * whole day before it clears 1,400 recipients.
	 *
	 * The assertion is against the walker's OWN plan rather than a literal, so the
	 * two cannot be corrected apart.
	 */
	it('quotes the walker plan, not the own-arm plan, at a uniform fractional share', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 1_400);
		configureSesEnv();
		await seedCampaignRoute(t, {
			strategy: 'adaptive_mix',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});
		await seedCampaignCellShares(t, 0.5);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');

		const audience = await t.run(async (ctx) => (await ctx.db.get(campaignId))?.audience);
		if (!audience) throw new Error('campaign missing its audience');
		const walker = await t.query(internal.campaigns.sendPlanQueries.getSendPlanCapacity, {
			audience,
			countAudienceSize: true,
		});
		expect(walker.plannedTotal).toBe(1_400);
		const walkerPlan = buildCapacitySchedule({
			audienceSize: 1_400,
			remainingCapacityByDay: walker.capacityByDay,
			now: MIDNIGHT,
		});

		// Six days over 0 / 100 / 200 / 200 / 700 / 700 — where the 700 own-arm
		// messages the verdict was decided on finish on day five.
		expect(walkerPlan.days).toBe(6);
		expect(result.capacityPlan?.days).toBe(walkerPlan.days);
		expect(result.capacityPlan?.slices).toEqual(walkerPlan.slices);
		expect(result.capacityPlan?.covered).toBe(1_400);
		expect(result.capacityPlan?.finishesAt).toBe(walkerPlan.finishesAt);
		expect(result.message).toContain('about 6 days');
	});
});
