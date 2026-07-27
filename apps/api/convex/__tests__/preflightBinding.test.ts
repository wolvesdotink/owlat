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
import { api, internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
	createTestSegment,
	createTestTopic,
} from './factories';
import {
	DAY_MS,
	MIDNIGHT,
	runPreflight,
	seedCampaignRoute,
	seedVerifiedRelayIdentity,
	seedWarmingState,
	useMtaPreflightEnv,
	warmingIp,
	type TestRunner,
} from './preflightFixtures';
import type { Id } from '../_generated/dataModel';
import { describeCapacitySchedule, validateReadyToSend } from '../campaigns/preflight';
import { MAX_PLAN_DAYS } from '../campaigns/capacityPlan';
import {
	assessCampaignCapacity,
	toAssessment,
	type CampaignCapacityAssessment,
} from '../campaigns/capacityPreflight';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock } = await import('./sessionOrganizationMock');
	return await sessionOrganizationMock();
});

const modules = import.meta.glob('../**/*.*s');

useMtaPreflightEnv();

/**
 * The gate's ASSESSMENT for a stored campaign, un-laundered by the pre-flight
 * ladder. `result.ok === true` cannot tell "allowed because the lower bound
 * decided nothing" apart from "allowed because the scan threw and
 * `assessCampaignCapacity`'s fail-open catch swallowed it" — the assessment
 * shape can (`capacityKnown: false` for the first, and for the second too, so
 * the suites that care assert it alongside a positive signal).
 */
async function assessCampaign(
	t: TestRunner,
	campaignId: Id<'campaigns'>,
	options: { startsAt?: number } = {}
): Promise<CampaignCapacityAssessment> {
	return await t.run(async (ctx) => {
		const campaign = await ctx.db.get(campaignId);
		if (!campaign?.audience) throw new Error('campaign missing its audience');
		return await assessCampaignCapacity(ctx, {
			audience: campaign.audience,
			fromEmail: campaign.fromEmail,
			now: MIDNIGHT,
			...options,
		});
	});
}

/**
 * A sendable campaign: template, verified domain, curated sender, and a topic
 * audience of `contactCount` eligible contacts.
 */
async function seedSendableCampaign(t: TestRunner, contactCount: number): Promise<Id<'campaigns'>> {
	let campaignId: Id<'campaigns'>;
	await t.run(async (ctx) => {
		const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'verified.example.com',
				status: 'verified',
				lastVerifiedAt: MIDNIGHT,
			})
		);
		await ctx.db.insert(
			'campaignSenders',
			createTestCampaignSender({ email: 'sender@verified.example.com' })
		);
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		for (let i = 0; i < contactCount; i += 1) {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: `person-${i}@subscriber.example.com`, doiStatus: 'confirmed' })
			);
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: MIDNIGHT });
		}
		campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'draft',
				emailTemplateId: templateId,
				fromEmail: 'sender@verified.example.com',
				audience: { kind: 'topic', topicId },
			})
		);
	});
	return campaignId!;
}

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
			finishesAt: MIDNIGHT + 5 * 24 * 60 * 60 * 1000,
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
		await seedWarmingState(t, { syncedAt: MIDNIGHT - 3 * 24 * 60 * 60 * 1000 });
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

		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: false, fits: true });
		expect((await runPreflight(t, campaignId)).ok).toBe(true);
	});

	it('allows the send when campaigns do not dispatch through the own MTA at all', async () => {
		const t = convexTest(schema, modules);
		// The MTA still carries transactional mail, so `warmingState` keeps syncing
		// — but no campaign byte is subject to its per-IP cap.
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		await seedCampaignRoute(t, {
			providers: [
				{ providerType: 'ses', isEnabled: true },
				{ providerType: 'mta', isEnabled: false },
			],
		});

		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: false, fits: true });
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
		});

		expect(plan).toEqual({ fits: true, capacityKnown: false });
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
		});
		expect(today.fits).toBe(false);

		// Anchored three days out the same IP is on schedule day 4: 200 / 700 /
		// 700 / 1500 = 3100. The send provably fits and must NOT be refused.
		const later = await t.query(api.campaigns.capacityPreflight.getCampaignCapacityPlan, {
			audience,
			startsAt: MIDNIGHT + 3 * 24 * 60 * 60 * 1000,
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
				scheduledAt: MIDNIGHT + 3 * 24 * 60 * 60 * 1000,
			});
			expect(scheduled.ok).toBe(true);
		});
	});
});

describe('toAssessment — the planner-verdict mapping', () => {
	it('treats the days === 0 sentinel as UNKNOWN capacity and allows the send', () => {
		expect(
			toAssessment({
				fits: false,
				days: 0,
				slices: [],
				finishesAt: MIDNIGHT,
				covered: 0,
				truncated: false,
				audienceUnderCounted: false,
			})
		).toEqual({ capacityKnown: false, fits: true });
	});

	it('passes a real schedule through as a measured refusal', () => {
		expect(
			toAssessment({
				fits: false,
				days: 2,
				slices: [100, 50],
				finishesAt: MIDNIGHT + 2 * 24 * 60 * 60 * 1000,
				covered: 150,
				truncated: false,
				audienceUnderCounted: false,
			})
		).toEqual({
			capacityKnown: true,
			fits: false,
			schedule: {
				fits: false,
				days: 2,
				slices: [100, 50],
				finishesAt: MIDNIGHT + 2 * 24 * 60 * 60 * 1000,
				covered: 150,
				truncated: false,
				audienceUnderCounted: false,
			},
		});
	});

	it('reports a fitting plan as measured', () => {
		expect(toAssessment({ fits: true })).toEqual({ capacityKnown: true, fits: true });
	});

	/**
	 * An under-counted audience is its OWN fact, not a truncated plan. Folding
	 * the two made a five-day schedule render as "more than 60 days" (D14).
	 */
	it('marks an under-counted audience without forging a truncated plan', () => {
		const plan = {
			fits: false as const,
			days: 5,
			slices: [0, 100, 200, 200, 100],
			finishesAt: MIDNIGHT + 5 * DAY_MS,
			covered: 600,
			truncated: false,
			audienceUnderCounted: false,
		};

		const assessment = toAssessment(plan, { audienceUnderCounted: true });

		expect(assessment.fits).toBe(false);
		if (assessment.fits) return;
		expect(assessment.schedule.audienceUnderCounted).toBe(true);
		expect(assessment.schedule.truncated).toBe(false);
		expect(describeCapacitySchedule(assessment.schedule)).toContain('at least 5 days');
	});
});

describe('describeCapacitySchedule — one sentence per state of knowledge', () => {
	const base = {
		fits: false as const,
		days: 5,
		slices: [0, 100, 200, 200, 100],
		finishesAt: MIDNIGHT + 5 * DAY_MS,
		covered: 600,
		truncated: false,
		audienceUnderCounted: false,
	};

	it('quotes the finish date only when both facts are known', () => {
		expect(describeCapacitySchedule(base)).toContain('about 5 days');
	});

	it('says "at least" when the audience is only a lower bound', () => {
		expect(describeCapacitySchedule({ ...base, audienceUnderCounted: true })).toContain(
			'at least 5 days'
		);
	});

	it('says "more than 60 days" only when the enumeration itself truncated', () => {
		expect(describeCapacitySchedule({ ...base, days: MAX_PLAN_DAYS, truncated: true })).toContain(
			`more than ${MAX_PLAN_DAYS} days`
		);
	});
});

describe('pre-flight capacity gate — one IP population (mixed graduated pools)', () => {
	/**
	 * `warmingState.phase` is only `'graduated'` when NO campaign IP is ramping,
	 * so a deployment of graduated IPs plus one freshly added day-1 IP reports
	 * phase `'ramp'`. Projecting only the day-1 IP would refuse campaigns the
	 * graduated IPs can deliver instantly — the false blocker D2/D10 forbid.
	 */
	it('does NOT refuse when a graduated campaign IP sits beside a day-1 one', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', {
				phase: 'ramp',
				totalDailyCap: 200_050,
				totalSentToday: 50,
				ipCount: 2,
				ips: [
					warmingIp({
						ip: '203.0.113.10',
						phase: 'ramp',
						currentDay: 1,
						dailyCap: 50,
						sentToday: 50,
					}),
					warmingIp({
						ip: '203.0.113.20',
						phase: 'graduated',
						currentDay: 90,
						dailyCap: 200_000,
					}),
				],
				syncedAt: MIDNIGHT,
			});
		});
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(true);
	});

	it('ignores a non-campaign pool IP rather than projecting it as campaign capacity', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', {
				phase: 'ramp',
				// Campaign-pool totals only — the transactional IP is not in them.
				totalDailyCap: 50,
				totalSentToday: 50,
				ipCount: 2,
				ips: [
					warmingIp({
						ip: '203.0.113.10',
						phase: 'ramp',
						currentDay: 1,
						dailyCap: 50,
						sentToday: 50,
					}),
					warmingIp({
						ip: '203.0.113.30',
						phase: 'ramp',
						currentDay: 30,
						dailyCap: 100_000,
						pool: 'transactional',
					}),
				],
				syncedAt: MIDNIGHT,
			});
		});
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await runPreflight(t, campaignId);

		// 0 / 100 / 200 / 200 from the campaign IP alone — still a refusal, and
		// the plan matches the single-IP projection exactly.
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
		expect(result.capacityPlan?.slices).toEqual([0, 100, 200, 200, 100]);
	});
});

/**
 * A narrow segment over `otherContacts` non-matching live contacts.
 *
 * `lookupConditions` adds that many `topic_membership` clauses, each of which
 * costs ONE extra document PER CONTACT on the bounded scan (a
 * `by_contact_and_topic` point read for every contact examined). They are
 * `not_equals` against topics with NO members, so every contact satisfies
 * them: the clauses raise the scan's READ COST without changing which
 * contacts match. That is the knob that exercises the per-document budget
 * without seeding tens of thousands of rows — and it is precisely the shape
 * that overruns the Convex per-execution limit when the budget is charged per
 * row instead.
 */
async function seedSegmentCampaign(
	t: TestRunner,
	opts: { matching: number; otherContacts: number; lookupConditions?: number }
): Promise<Id<'campaigns'>> {
	let campaignId: Id<'campaigns'>;
	await t.run(async (ctx) => {
		const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'verified.example.com',
				status: 'verified',
				lastVerifiedAt: MIDNIGHT,
			})
		);
		await ctx.db.insert(
			'campaignSenders',
			createTestCampaignSender({ email: 'sender@verified.example.com' })
		);
		const lookupHeavyConditions: {
			kind: 'topic_membership';
			operator: 'not_equals';
			topicId: Id<'topics'>;
		}[] = [];
		for (let i = 0; i < (opts.lookupConditions ?? 0); i += 1) {
			const emptyTopicId = await ctx.db.insert(
				'topics',
				createTestTopic({ requireDoubleOptIn: false })
			);
			lookupHeavyConditions.push({
				kind: 'topic_membership',
				operator: 'not_equals',
				topicId: emptyTopicId,
			});
		}
		for (let i = 0; i < opts.otherContacts; i += 1) {
			await ctx.db.insert(
				'contacts',
				createTestContact({ email: `noise-${i}@other.test`, doiStatus: 'not_required' })
			);
		}
		for (let i = 0; i < opts.matching; i += 1) {
			await ctx.db.insert(
				'contacts',
				createTestContact({ email: `member-${i}@seg.test`, doiStatus: 'not_required' })
			);
		}
		const segmentId = await ctx.db.insert(
			'segments',
			createTestSegment({
				name: 'seg.test folks',
				filters: {
					logic: 'AND',
					conditions: [
						{
							kind: 'contact_property',
							field: 'email',
							operator: 'contains',
							value: 'seg.test',
						},
						...lookupHeavyConditions,
					],
				},
			})
		);
		campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'draft',
				emailTemplateId: templateId,
				fromEmail: 'sender@verified.example.com',
				audience: { kind: 'segment', segmentId },
			})
		);
	});
	return campaignId!;
}

describe('pre-flight capacity gate — segment audiences', () => {
	it('refuses an over-capacity segment audience the scan can finish reading', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSegmentCampaign(t, { matching: 600, otherContacts: 20 });

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
		expect(result.capacityPlan?.covered).toBe(600);
	});

	/**
	 * The document budget is the only bound that holds for a segment: the scan
	 * walks every LIVE contact, not just matches. THREE `topic_membership`
	 * clauses put the per-contact cost at four documents (the contact plus one
	 * point read each), so 6,000 documents buys 1,500 contacts — and the 1,600-row
	 * noise floor is read before any of the 600 matches. The surviving lower bound
	 * is 0, below horizon capacity, therefore undecided, therefore allowed. A
	 * failure to MEASURE never blocks a send.
	 *
	 * The multiplier is the point: charge per ROW and this scan reads 6,400
	 * documents inside a send mutation, over the Convex per-execution limit.
	 *
	 * Asserted on the ASSESSMENT, not just on `ok`: `{ capacityKnown: false }`
	 * distinguishes "the lower bound decided nothing" from "the scan threw and
	 * the fail-open catch swallowed it", which `ok === true` alone cannot.
	 */
	it('allows the send when the audience scan exhausts its read budget', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSegmentCampaign(t, {
			matching: 600,
			otherContacts: 1_600,
			lookupConditions: 3,
		});

		const result = await runPreflight(t, campaignId);
		expect(result.ok).toBe(true);

		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: false, fits: true });
	});
});

describe('pre-flight capacity gate — hostile start anchors', () => {
	it('collapses a NaN scheduledAt onto the today anchor instead of yielding NaN', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await runPreflight(t, campaignId, { scheduledAt: Number.NaN });

		// The today anchor refuses 600 against 0 / 100 / 200 / 200 — the same
		// verdict as no anchor at all, and never a NaN-poisoned plan.
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
		expect(result.capacityPlan?.days).toBe(5);
		expect(Number.isFinite(result.capacityPlan?.finishesAt ?? Number.NaN)).toBe(true);
	});

	/**
	 * A start anchor in the PAST is asserted straight on the assessment: the
	 * shipped `scheduled_in_past` check would win the pre-flight ladder long
	 * before the capacity gate ran, so the ladder cannot pin this.
	 */
	it('collapses a start anchor in the PAST onto the today anchor', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);

		const assessment = await assessCampaign(t, campaignId, {
			startsAt: MIDNIGHT - 10 * DAY_MS,
		});

		expect(assessment.fits).toBe(false);
		if (assessment.fits) return;
		expect(assessment.schedule.slices).toEqual([0, 100, 200, 200, 100]);
	});
});

describe('the fire-time path does NOT re-run the capacity gate', () => {
	/**
	 * A capacity refusal at fire time has no consumer: `startCampaignSend` turns
	 * it into `{ skipped: true }`, the campaign stays `scheduled`, and the
	 * per-minute cron re-skips it forever. That trades "the tail silently
	 * expires" for "the campaign silently never starts", so the gate stays a
	 * pre-flight-TIME decision.
	 */
	it('passes a campaign the schedule-time gate would refuse', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);

		const atScheduleTime = await runPreflight(t, campaignId);
		expect(atScheduleTime.ok).toBe(false);
		if (!atScheduleTime.ok) expect(atScheduleTime.reason).toBe('exceeds_sending_capacity');

		const atFireTime = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});
		expect(atFireTime.ok).toBe(true);
	});

	it('still enforces every shipped fire-time check', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		// Drift the campaign the way the fire-time re-check exists to catch.
		await t.run(async (ctx) => {
			await ctx.db.patch(campaignId, { emailTemplateId: undefined });
		});

		const atFireTime = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});

		expect(atFireTime.ok).toBe(false);
		if (atFireTime.ok) return;
		expect(atFireTime.reason).toBe('no_template');
	});
});

describe('pre-flight capacity gate — audiences past the read budget', () => {
	/**
	 * The gate's document budget (6,000 documents) is smaller than the audiences
	 * this piece exists to stop. Throwing the partial count away would make the
	 * budget an OFF switch for exactly those campaigns, so the partial count is
	 * kept as a LOWER BOUND: a floor already above the capacity inside the
	 * retention horizon is a sound refusal, because the real audience can only be
	 * bigger.
	 *
	 * A topic candidate costs TWO documents (the membership plus its contact), so
	 * 6,000 documents buys exactly 3,000 candidates — the pinned proof that the
	 * budget is charged per document and not per row. The audience is seeded just
	 * past that (3,100): a bigger one would prove nothing further and every extra
	 * contact is two more convex-test writes.
	 */
	it('still REFUSES a topic audience larger than the read budget', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 3_100);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
		// The plan is built from the 3,000-candidate floor, not from 3,100 …
		expect(result.capacityPlan?.covered).toBe(3_000);
		// … and it says so, rather than quoting a finish date for an audience we
		// never finished counting.
		expect(result.capacityPlan?.audienceUnderCounted).toBe(true);
		expect(result.capacityPlan?.truncated).toBe(false);
		expect(result.message).toContain('at least');
	});

	/**
	 * The mirror case: the floor is BELOW horizon capacity, so it decides nothing
	 * and the send is allowed. A failure to measure never blocks (D2/D10) — the
	 * `otherContacts` noise floor exhausts the budget before the 40 matches are
	 * reached.
	 */
	it('allows a small audience hidden behind a read-budget-exhausting noise floor', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSegmentCampaign(t, {
			matching: 40,
			otherContacts: 1_600,
			lookupConditions: 3,
		});

		const result = await runPreflight(t, campaignId);
		expect(result.ok).toBe(true);

		// Allowed because the lower bound decided nothing — NOT because the scan
		// threw and the fail-open catch swallowed it.
		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: false, fits: true });
	});
});

describe('pre-flight capacity gate — the projection horizon', () => {
	/** Seed ONE active campaign IP at `currentDay` with an unspent daily cap. */
	async function seedIpAtDay(t: TestRunner, currentDay: number, dailyCap: number): Promise<void> {
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', {
				phase: 'ramp',
				totalDailyCap: dailyCap,
				totalSentToday: 0,
				ipCount: 1,
				ips: [warmingIp({ ip: '203.0.113.10', phase: 'ramp', currentDay, dailyCap })],
				syncedAt: MIDNIGHT,
			});
		});
	}

	/**
	 * `BASE_WARMING_SCHEDULE` day 30 is `Infinity` — the MTA stops throttling. An
	 * IP that crosses it INSIDE the four-day retention horizon has unbounded
	 * capacity there, so the projection cannot bound that day at all and the answer
	 * must be "unknown", never a clamped number the gate could refuse against.
	 */
	it('reports UNKNOWN capacity when the horizon crosses schedule day 30', async () => {
		const t = convexTest(schema, modules);
		await seedIpAtDay(t, 27, 30_000);
		const campaignId = await seedSendableCampaign(t, 600);

		const assessment = await assessCampaign(t, campaignId);

		expect(assessment).toEqual({ capacityKnown: false, fits: true });
	});

	it('still measures when the horizon stops short of schedule day 30', async () => {
		const t = convexTest(schema, modules);
		await seedIpAtDay(t, 25, 30_000);
		const campaignId = await seedSendableCampaign(t, 600);

		const assessment = await assessCampaign(t, campaignId);

		expect(assessment).toEqual({ capacityKnown: true, fits: true });
	});
});

describe('pre-flight capacity gate — inactive campaign IPs', () => {
	/**
	 * `warmingState.totalDailyCap` / `totalSentToday` roll up EVERY campaign-pool
	 * IP regardless of `active`, so taking today's remainder from them counted a
	 * different population than the forward projection (active IPs only). A
	 * deactivated IP would then inflate day 0 alone and wave through a campaign
	 * nothing can actually send.
	 */
	it('does not count a deactivated campaign IP as today’s capacity', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', {
				phase: 'ramp',
				// The shipped rollup includes the inactive IP — 100,000 + 50.
				totalDailyCap: 100_050,
				totalSentToday: 50,
				ipCount: 2,
				ips: [
					warmingIp({
						ip: '203.0.113.10',
						phase: 'ramp',
						currentDay: 1,
						dailyCap: 50,
						sentToday: 50,
					}),
					warmingIp({
						ip: '203.0.113.40',
						phase: 'ramp',
						currentDay: 12,
						dailyCap: 100_000,
						active: false,
					}),
				],
				syncedAt: MIDNIGHT,
			});
		});
		const campaignId = await seedSendableCampaign(t, 600);

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('exceeds_sending_capacity');
		// The active day-1 IP alone: 0 / 100 / 200 / 200 / 700 …
		expect(result.capacityPlan?.slices).toEqual([0, 100, 200, 200, 100]);
	});
});

describe('the capacity gate never blocks the schedule mutation', () => {
	/**
	 * A segment carrying a `topic_membership` condition used to drag the WHOLE
	 * `contactTopics.by_topic` range into `campaigns.scheduling.schedule` through
	 * the unbounded condition preload. Past the Convex per-execution read limit
	 * that made the mutation throw and the campaign unschedulable — a failure to
	 * MEASURE blocking a SEND (D2). The budgeted scan now preloads per batch.
	 */
	it('schedules a segment campaign whose filter spans a very large topic', async () => {
		const t = convexTest(schema, modules);
		// Plenty of capacity, and short of schedule day 30 across the horizon.
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', {
				phase: 'ramp',
				totalDailyCap: 30_000,
				totalSentToday: 0,
				ipCount: 1,
				ips: [warmingIp({ ip: '203.0.113.10', phase: 'ramp', currentDay: 25, dailyCap: 30_000 })],
				syncedAt: MIDNIGHT,
			});
		});
		const campaignId = await t.run(async (ctx) => {
			const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
			await ctx.db.insert(
				'domains',
				createTestDomain({
					domain: 'verified.example.com',
					status: 'verified',
					lastVerifiedAt: MIDNIGHT,
				})
			);
			await ctx.db.insert(
				'campaignSenders',
				createTestCampaignSender({ email: 'sender@verified.example.com' })
			);
			const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			// Comfortably past SEGMENT_LOOKUP_BATCH, so the scan drains several
			// batches of point reads — which is what proves the preload no longer
			// collects the whole junction table. Exhausting the budget is not this
			// test's claim (the two cases above own that), and every extra member is
			// another point read against a growing table under coverage.
			for (let i = 0; i < 800; i += 1) {
				const contactId = await ctx.db.insert(
					'contacts',
					createTestContact({ email: `member-${i}@big.test`, doiStatus: 'not_required' })
				);
				await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: MIDNIGHT });
			}
			const segmentId = await ctx.db.insert(
				'segments',
				createTestSegment({
					name: 'big topic members',
					filters: {
						logic: 'AND',
						conditions: [{ kind: 'topic_membership', operator: 'equals', topicId }],
					},
				})
			);
			return await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					fromEmail: 'sender@verified.example.com',
					audience: { kind: 'segment', segmentId },
				})
			);
		});

		// No throw: the gate measured (or declined to) without escaping the mutation.
		await t.mutation(api.campaigns.scheduling.schedule, {
			campaignId,
			scheduledAt: MIDNIGHT + DAY_MS,
		});

		const scheduled = await t.run(async (ctx) => await ctx.db.get(campaignId));
		expect(scheduled?.status).toBe('scheduled');
	});
});

describe('pre-flight capacity gate — a suppression list past the bounded scan', () => {
	/**
	 * The budgeted scan reads the suppression list with `.take()` rather than
	 * `.collect()` — collecting it inside `campaigns.scheduling.schedule` would
	 * put every suppressed address in the mutation's OCC read set, and an OCC
	 * conflict is raised at COMMIT time, where the gate's fail-open catch can no
	 * longer turn it into "allow" (D16).
	 *
	 * The consequence has to be handled honestly: candidates filtered through a
	 * SUBSET of the blocklist yield an OVER-count of eligible recipients, which
	 * bounds the audience in NEITHER direction. Unlike a spent read budget it may
	 * therefore never license a refusal — and the audience here (600 against a
	 * 500-recipient horizon, well inside the document budget) is one the gate
	 * refuses outright whenever it CAN read the blocklist in full.
	 */
	it('never refuses on an over-count from a truncated suppression set', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSendableCampaign(t, 600);
		await t.run(async (ctx) => {
			for (let i = 0; i < 2_001; i += 1) {
				await ctx.db.insert('blockedEmails', {
					email: `blocked-${i}@nowhere.test`,
					reason: 'manual',
					createdAt: MIDNIGHT,
				});
			}
		});

		const result = await runPreflight(t, campaignId);
		expect(result.ok).toBe(true);

		expect(await assessCampaign(t, campaignId)).toEqual({ capacityKnown: false, fits: true });
	});
});
