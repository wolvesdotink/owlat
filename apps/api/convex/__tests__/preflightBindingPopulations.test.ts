/**
 * P0-5 — the capacity gate over the audience and IP populations it has to
 * read: one mixed-pool IP population, segment audiences, hostile start
 * anchors, audiences past the read budget, the projection horizon, and
 * inactive campaign IPs.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
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
	seedWarmingState,
	warmingIp,
	assessCampaign,
	seedSendableCampaign,
	useMtaPreflightEnv,
	type TestRunner,
} from './preflightFixtures';
import type { Id } from '../_generated/dataModel';

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
	// Seeding 2 200 contacts with per-contact lookups is seconds of work idle
	// but has hit 41s on the release gate's shared runner (which runs the whole
	// monorepo, unlike the sharded test.yml) — give it an explicit deadline.
	it(
		'allows the send when the audience scan exhausts its read budget',
		{ timeout: 120_000 },
		async () => {
			const t = convexTest(schema, modules);
			await seedWarmingState(t);
			const campaignId = await seedSegmentCampaign(t, {
				matching: 600,
				otherContacts: 1_600,
				lookupConditions: 3,
			});

			const result = await runPreflight(t, campaignId);
			expect(result.ok).toBe(true);

			expect(await assessCampaign(t, campaignId)).toEqual({
				capacityKnown: false,
				fits: true,
				unknownReason: 'audience_under_counted',
			});
		}
	);
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
	// Same 1 600-contact noise floor as the read-budget test above: seconds
	// idle, 23s observed on the loaded release runner — explicit deadline.
	it(
		'allows a small audience hidden behind a read-budget-exhausting noise floor',
		{ timeout: 120_000 },
		async () => {
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
			expect(await assessCampaign(t, campaignId)).toEqual({
				capacityKnown: false,
				fits: true,
				unknownReason: 'audience_under_counted',
			});
		}
	);
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

		expect(assessment).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'projection_shorter_than_horizon',
		});
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
