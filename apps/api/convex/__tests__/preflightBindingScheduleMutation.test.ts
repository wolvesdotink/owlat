/**
 * P0-5 — where the capacity gate must NOT bind: the fire-time path does not
 * re-run it, the schedule mutation is never blocked by it, a suppression list
 * past the bounded scan cannot refuse, and the fail-open catch (D2) turns a
 * thrown scan into "unknown", never into a refusal.
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
	warmingIp,
	assessCampaign,
	seedSendableCampaign,
	useMtaPreflightEnv,
} from './preflightFixtures';
import type { Id } from '../_generated/dataModel';
import { assessCampaignCapacity } from '../campaigns/capacityPreflight';

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

		expect(await assessCampaign(t, campaignId)).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'audience_over_counted',
		});
	});
});

describe('assessCampaignCapacity — the fail-open catch (D2)', () => {
	it('allows the send with measurement_failed when the measurement itself throws', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		let topicId: Id<'topics'>;
		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		});

		// A ctx whose very first document read throws. This is the branch that
		// GUARANTEES a measurement fault can never block a send: an exception
		// escaping the assessment would not refuse the campaign, it would make
		// `schedule` throw — a failure to MEASURE blocking a SEND,
		// exactly what D2 forbids.
		const assessment = await t.run(async (ctx) => {
			const hostileCtx = {
				...ctx,
				db: {
					...ctx.db,
					query: () => {
						throw new Error('read limit exceeded');
					},
					get: () => {
						throw new Error('read limit exceeded');
					},
				},
			} as unknown as Parameters<typeof assessCampaignCapacity>[0];
			return await assessCampaignCapacity(hostileCtx, {
				audience: { kind: 'topic', topicId: topicId! },
				fromEmail: 'sender@verified.example.com',
				now: MIDNIGHT,
			});
		});

		expect(assessment).toEqual({
			capacityKnown: false,
			fits: true,
			unknownReason: 'measurement_failed',
		});
	});
});
