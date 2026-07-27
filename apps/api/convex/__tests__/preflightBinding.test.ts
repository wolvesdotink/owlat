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
	seedWarmingState,
	useMtaPreflightEnv,
	warmingIp,
	type TestRunner,
} from './preflightFixtures';
import type { Id } from '../_generated/dataModel';
import { validateReadyToSend } from '../campaigns/preflight';
import { assessCampaignCapacity, toAssessment } from '../campaigns/capacityPreflight';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock } = await import('./preflightFixtures');
	return await sessionOrganizationMock();
});

const modules = import.meta.glob('../**/*.*s');

useMtaPreflightEnv();

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

describe('pre-flight capacity gate — segment audiences', () => {
	/** A narrow segment over `otherContacts` non-matching live contacts. */
	async function seedSegmentCampaign(
		t: TestRunner,
		opts: { matching: number; otherContacts: number }
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
	 * The examine ceiling is the only bound that holds for a segment: the scan
	 * walks every LIVE contact, not just matches. Running out of read budget is
	 * a failure to MEASURE, and a failure to measure never blocks a send.
	 */
	it('allows the send when the audience scan exhausts its read budget', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedSegmentCampaign(t, { matching: 600, otherContacts: 8_100 });

		const result = await runPreflight(t, campaignId);

		expect(result.ok).toBe(true);
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

		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(campaignId);
			if (!campaign?.audience) throw new Error('campaign missing its audience');
			const assessment = await assessCampaignCapacity(ctx, {
				audience: campaign.audience,
				now: MIDNIGHT,
				startsAt: MIDNIGHT - 10 * DAY_MS,
			});
			expect(assessment.fits).toBe(false);
			if (assessment.fits) return;
			expect(assessment.schedule.slices).toEqual([0, 100, 200, 200, 100]);
		});
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
