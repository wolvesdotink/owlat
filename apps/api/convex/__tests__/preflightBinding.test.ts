/**
 * P0-5 — the BINDING capacity gate at pre-flight.
 *
 * A warming deployment with no relay to overflow to can start a campaign it
 * provably cannot finish; the tail then silently expires in the MTA queue.
 * These tests prove the refusal is real (with a structured multi-day plan
 * attached), that a finishable campaign is untouched, and — the case the plan
 * cares about most (D2/D10) — that UNKNOWN capacity never blocks a send.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestContact, createTestTopic } from './factories';
import {
	configureSesEnv,
	DAY_MS,
	MIDNIGHT,
	runPreflight,
	seedCampaignRoute,
	seedVerifiedRelayIdentity,
	seedWarmingState,
	assessCampaign,
	seedSendableCampaign,
	useMtaPreflightEnv,
} from './preflightFixtures';
import type { Id } from '../_generated/dataModel';
import { validateReadyToSend } from '../campaigns/preflight';

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

describe('pre-flight capacity gate — binding refusal', () => {
	it('refuses a campaign that cannot finish inside the retention horizon, with the plan attached', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
		// 600 recipients against 0 / 100 / 200 / 200 / 700 …
		expect(result.capacityPlan).toEqual({
			fits: false,
			days: 5,
			slices: [0, 100, 200, 200, 100],
			finishesAt: MIDNIGHT + 5 * DAY_MS,
			covered: 600,
			truncated: false,
			audienceUnderCounted: false,
		});
		// The copy is a schedule, not an error.
		expect(result.message).toContain('5 days');
	});

	it('leaves a campaign that fits untouched', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 40);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(true);
	});
});

describe('pre-flight capacity gate — never a false blocker (D2/D10)', () => {
	it('allows the send when there is no warming state at all', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(true);
	});

	it('allows the send when warming state is stale (the MTA sync stopped)', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t, { syncedAt: MIDNIGHT - 3 * DAY_MS });
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(true);
	});

	it('allows the send on a graduated deployment (no warming cap to bind against)', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t, { phase: 'graduated' });
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(true);
	});

	it('allows the send when the projection has no positive capacity anywhere', async () => {
		const t = convexTest(schema, modules);
		// No active IPs: nothing to project, so capacity is unknown, not zero.
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', {
				phase: 'ramp',
				totalDailyCap: 0,
				totalSentToday: 0,
				ipCount: 1,
				ips: [
					{
						ip: '203.0.113.11',
						phase: 'ramp',
						currentDay: 1,
						dailyCap: 0,
						sentToday: 0,
						bounceRate: 0,
						deferralRate: 0,
						pool: 'campaign',
						active: false,
					},
				],
				syncedAt: MIDNIGHT,
			});
		});
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(true);
	});

	it('allows a campaign whose audience resolves to zero recipients', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 0);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(true);
	});
});

/**
 * The gate exists for ONE configuration: campaigns on the own MTA with no relay
 * to overflow to. Everywhere else the warming cap cannot strand a campaign, and
 * a refusal would be a false blocker on traffic that ships fine today.
 *
 * Every fixture below is the SAME 600-recipient audience against the SAME
 * day-1 IP that the binding suite proves is refused — only the campaign route
 * differs, so the route really is what decides.
 */
describe('pre-flight capacity gate — the cap must actually bind campaign traffic', () => {
	it('allows the send when warm-up overflow to a VERIFIED relay absorbs the tail', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedVerifiedRelayIdentity(t, 'verified.example.com');
		await seedCampaignRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'ses',
				isWarmupOverflowEnabled: true,
			},
		});

		expect(await assessCampaign(t, campaignId)).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'warmup_overflow_absorbs',
		});
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	/**
	 * ENABLED IS NOT READY. A half-set-up SES entry alongside the MTA is the most
	 * common shape of a warming deployment mid-configuration — and it is exactly
	 * the shape that used to turn this gate off. `resolveRoute` filters route
	 * entries through `isSendProviderReady`, so every campaign byte really does
	 * still go through the capped MTA and really can strand.
	 */
	it('still refuses when the only non-MTA campaign provider is enabled but NOT READY', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		// Deliberately NO `configureSesEnv()`: the entry is enabled, uncredentialed.
		await seedCampaignRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
	});

	/**
	 * Under `priority_failover` a second READY provider is a HEALTH failover, not
	 * a traffic split: with the MTA selected and healthy, 100% of campaign
	 * traffic still goes through it, so the cap binds exactly as it does with no
	 * second provider at all.
	 */
	it('still refuses under priority_failover when a ready SES is only a failover', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
	});

	/**
	 * `workload_split` is the one strategy where an enabled second provider
	 * really does carry a share of the audience, so part of the send bypasses
	 * the cap and the projection stops being an upper bound.
	 */
	it('allows the send under workload_split when a ready SES carries part of the audience', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			strategy: 'workload_split',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		});

		expect(await assessCampaign(t, campaignId)).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'not_own_mta',
		});
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	/**
	 * THE VERDICT IS A FUNCTION OF THE CONFIGURATION, NOT OF A DICE ROLL.
	 *
	 * `workload_split` picks among the enabled+ready entries by WEIGHTED RANDOM
	 * draw, and with the escape hatch enabled but the From-domain's relay proof
	 * ABSENT the shipped resolver throws on exactly the draws that land on the
	 * relay entry. A gate that read its answer off the selected route therefore
	 * answered "allow" on some draws and "refuse over N days" on others for the
	 * same clock and the same rows — and since the wizard preview and the binding
	 * gate are separate calls, each drawing its own number, the operator could be
	 * quoted one answer and get the other. Both extremes of the draw must land on
	 * the same verdict.
	 */
	it('answers deterministically under workload_split with an unproven relay escape hatch', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		// Deliberately NO `seedVerifiedRelayIdentity`: the From-domain carries no
		// current relay proof, so the relay draw makes the shipped resolver throw.
		await seedCampaignRoute(t, {
			strategy: 'workload_split',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'ses',
				isWarmupOverflowEnabled: true,
			},
		});

		// Both ends of the weighted-random draw, plus unstubbed repeats.
		const draws = [0, 0.999_999, null] as const;
		for (const draw of draws) {
			const random = draw === null ? null : vi.spyOn(Math, 'random').mockReturnValue(draw);
			try {
				for (let attempt = 0; attempt < (draw === null ? 20 : 1); attempt += 1) {
					// SES carries a real share of the audience here, so the projection
					// is not an upper bound and the cap cannot strand the campaign.
					expect(await assessCampaign(t, campaignId)).toEqual({
						capacityKnown: false,
						fits: true,
						unknownReason: 'not_own_mta',
					});
					expect((await runPreflight(t, campaignId)).ok).toBe(true);
				}
			} finally {
				random?.mockRestore();
			}
		}
	});

	/**
	 * THE ENV-FALLBACK BRANCH. `workload_split` whose only route entry is enabled
	 * but NOT READY leaves `resolveRoute` with no enabled entry at all, so it
	 * falls through to the `EMAIL_PROVIDER` default — the own MTA. The gate must
	 * read the campaign's dispatch kind off that resolved base route (there is no
	 * enabled+ready set to read it from) and still bind.
	 */
	it('refuses under workload_split when only the env default is left to dispatch through', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		// No `configureSesEnv()`: the single SES entry is enabled, uncredentialed.
		await seedCampaignRoute(t, {
			strategy: 'workload_split',
			providers: [{ providerType: 'ses', isEnabled: true }],
		});

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
	});

	/**
	 * DISABLED IS NOT A DISPATCH PATH, however ready it is. The gate reads
	 * readiness out of `SendRouteFacts.readyKinds`, which is computed over EVERY
	 * kind named in `providerRoutes.providers` — `isEnabled` or not — so a
	 * credentialed but DISABLED SES entry is present in that set and must still
	 * not count as a share of the audience, nor as an overflow target.
	 */
	it('still refuses under workload_split when a READY SES entry is disabled', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedVerifiedRelayIdentity(t, 'verified.example.com');
		await seedCampaignRoute(t, {
			strategy: 'workload_split',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: false },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'ses',
				isWarmupOverflowEnabled: true,
			},
		});

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
	});

	it('allows the send when campaigns do not dispatch through the own MTA at all', async () => {
		const t = convexTest(schema, modules);
		// The MTA still carries transactional mail, so `warmingState` keeps syncing
		// — but no campaign byte is subject to its per-IP cap.
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			providers: [
				{ providerType: 'ses', isEnabled: true },
				{ providerType: 'mta', isEnabled: false },
			],
		});

		expect(await assessCampaign(t, campaignId)).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'not_own_mta',
		});
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	/**
	 * NOTHING IS KNOWN ABOUT WHERE CAMPAIGNS DISPATCH. Under a DETERMINISTIC
	 * strategy the shipped resolver still throws for an unusable relay
	 * configuration — here `single` selects the SES entry while an MTA entry is
	 * also enabled, which is a hybrid relay selection with no relay proof. The
	 * gate loses the selected route to that throw and has no other handle on the
	 * campaign's dispatch kind, so it holds and allows (D10) — and says so, with
	 * `dispatch_unknown` rather than the reassuring `not_own_mta`. The two are
	 * NOT interchangeable: one means the cap provably does not apply, the other
	 * means we could not tell.
	 */
	it('answers dispatch_unknown when no route can be selected at all', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		// No `seedVerifiedRelayIdentity`: the hybrid relay selection has no proof.
		await seedCampaignRoute(t, {
			strategy: 'single',
			providers: [
				{ providerType: 'ses', isEnabled: true },
				{ providerType: 'mta', isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'ses',
				isWarmupOverflowEnabled: true,
			},
		});

		expect(await assessCampaign(t, campaignId)).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'dispatch_unknown',
		});
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	/**
	 * Overflow that is CONFIGURED but cannot actually happen — the From-domain
	 * carries no relay proof — leaves the tail deferring exactly as it does
	 * without a relay, so the gate must still bind.
	 */
	it('still refuses when overflow is enabled but the relay domain is unverified', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedCampaignRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'ses',
				isWarmupOverflowEnabled: true,
			},
		});

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
	});

	/**
	 * A verified relay that is NOT wired to warm-up overflow only catches
	 * infrastructure signals (dnsbl, breaker); the warming cap still defers.
	 */
	it('still refuses when a verified relay is configured without warm-up overflow', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		configureSesEnv();
		await seedVerifiedRelayIdentity(t, 'verified.example.com');
		await seedCampaignRoute(t, {
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'ses',
				isWarmupOverflowEnabled: false,
			},
		});

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
	});
});

describe('getCampaignCapacityPlan — the UI preview', () => {
	it('reports capacityKnown: false when nothing can be measured', async () => {
		const t = convexTest(schema, modules);
		let topicId: Id<'topics'>;
		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		});

		const plan = await t.query(api.campaigns.capacityPreflight.getCampaignCapacityPlan, {
			audience: { kind: 'topic', topicId: topicId! },
			fromEmail: 'sender@verified.example.com',
		});

		expect(plan).toEqual({ fits: true, capacityKnown: false, unknownReason: 'no_projection' });
	});

	it('answers no_audience when the wizard has not chosen one yet', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);

		// The preview is rendered from the FIRST wizard step onward, before an
		// audience exists. Nothing to judge is not a fault: it is `capacityKnown:
		// false`, `fits: true` — the panel simply does not render (D2).
		const plan = await t.query(api.campaigns.capacityPreflight.getCampaignCapacityPlan, {
			fromEmail: 'sender@verified.example.com',
		});

		expect(plan).toEqual({ fits: true, capacityKnown: false, unknownReason: 'no_audience' });
	});

	it("assesses a future start against the capacity it will have THEN, not today's", async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		let topicId: Id<'topics'>;
		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			for (let i = 0; i < 600; i += 1) {
				const contactId = await ctx.db.insert(
					'contacts',
					createTestContact({ email: `person-${i}@subscriber.example.com`, doiStatus: 'confirmed' })
				);
				await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: MIDNIGHT });
			}
		});
		const audience = { kind: 'topic' as const, topicId: topicId! };

		// Anchored at now, a day-1 IP projects 0 / 100 / 200 / 200 = 500 over the
		// four-day retention horizon, so 600 recipients do not fit.
		const today = await t.query(api.campaigns.capacityPreflight.getCampaignCapacityPlan, {
			audience,
			fromEmail: 'sender@verified.example.com',
		});
		expect(today.fits).toBe(false);

		// Anchored three days out the same IP is on schedule day 4: 200 / 700 /
		// 700 / 1500 = 3100. The send provably fits and must NOT be refused.
		const later = await t.query(api.campaigns.capacityPreflight.getCampaignCapacityPlan, {
			audience,
			fromEmail: 'sender@verified.example.com',
			startsAt: MIDNIGHT + 3 * DAY_MS,
		});
		expect(later).toEqual({ capacityKnown: true, fits: true });
	});
});

describe('pre-flight capacity gate — scheduled sends', () => {
	it('does not refuse a future-scheduled campaign that fits its fire-time window', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);

		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(campaignId);
			if (!campaign) throw new Error('campaign missing');

			// Same campaign, same instant, two different anchors.
			const immediate = await validateReadyToSend(ctx, campaign, { now: MIDNIGHT });
			expect(immediate.ok).toBe(false);
			if (!immediate.ok) expect(immediate.reason).toBe('exceeds_sending_capacity');

			const scheduled = await validateReadyToSend(ctx, campaign, {
				now: MIDNIGHT,
				scheduledAt: MIDNIGHT + 3 * DAY_MS,
			});
			expect(scheduled.ok).toBe(true);
		});
	});
});
