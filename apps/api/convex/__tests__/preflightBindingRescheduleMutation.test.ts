/**
 * `campaigns.scheduling.reschedule` runs the same pre-flight as `schedule`,
 * anchored at the NEW start.
 *
 * Capacity is judged against the start time because warming caps grow: a
 * 1,300-recipient campaign on a day-1 IP does not fit if it starts within the
 * hour, and fits comfortably three days out. Before reschedule ran pre-flight, a campaign
 * scheduled for later could be pulled forward with no capacity check at all,
 * and the tail of the send expired in the MTA queue. The same gap let a
 * reschedule through after its sender left the allow-list.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	DAY_MS,
	MIDNIGHT,
	seedSendableCampaign,
	seedWarmingState,
	useMtaPreflightEnv,
	type TestRunner,
} from './preflightFixtures';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock, MOCK_SINGLETON_ORG } = await import('./sessionOrganizationMock');
	return {
		...(await sessionOrganizationMock()),
		getSingletonOrganizationId: vi.fn().mockResolvedValue(MOCK_SINGLETON_ORG),
	};
});

const modules = import.meta.glob('../**/*.*s');

useMtaPreflightEnv();

const HOUR_MS = 60 * 60 * 1000;

/**
 * Three days out the day-1 IP is on schedule day 4, and the four-day horizon
 * carries 200 / 700 / 700 / 1,500 recipients.
 */
const FITTING_START = MIDNIGHT + 3 * DAY_MS;

/**
 * An hour from now the five-day horizon (the start is past midnight, so the
 * expiry reaches into a fifth day) carries 0 / 100 / 200 / 200 / 700 = 1,200.
 */
const TIGHT_START = MIDNIGHT + HOUR_MS;

/** Fits at `FITTING_START`, exceeds capacity at `TIGHT_START`. */
const LARGE_AUDIENCE = 1_300;

/**
 * A campaign scheduled through the real `schedule` mutation at a start it
 * fits, so every case starts from a campaign pre-flight accepted.
 */
async function seedScheduledCampaign(t: TestRunner, contactCount = 10): Promise<Id<'campaigns'>> {
	await seedWarmingState(t);
	const campaignId = await seedSendableCampaign(t, contactCount);
	await t.mutation(api.campaigns.scheduling.schedule, {
		campaignId,
		scheduledAt: FITTING_START,
	});
	const campaign = await t.run(async (ctx) => await ctx.db.get(campaignId));
	expect(campaign?.status).toBe('scheduled');
	return campaignId;
}

interface Refusal {
	category: string;
	message: string;
	data?: Record<string, unknown>;
}

/** The operation error a pre-flight refusal throws (a `ConvexError`'s `data`). */
async function refusalOf(promise: Promise<unknown>): Promise<Refusal> {
	try {
		await promise;
	} catch (error) {
		return (error as { data: Refusal }).data;
	}
	throw new Error('expected the mutation to be refused');
}

describe('campaigns.scheduling.reschedule runs the schedule pre-flight', () => {
	it('refuses pulling a campaign forward into a window that exceeds capacity', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedScheduledCampaign(t, LARGE_AUDIENCE);

		const refusal = await refusalOf(
			t.mutation(api.campaigns.scheduling.reschedule, {
				campaignId,
				scheduledAt: TIGHT_START,
			})
		);

		expect(refusal.category).toBe('invalid_state');
		expect(refusal.data?.['reason']).toBe('exceeds_sending_capacity');
		const plan = refusal.data?.['capacityPlan'] as {
			days: number;
			covered: number;
			slices: number[];
		};
		expect(plan.days).toBeGreaterThan(1);
		expect(plan.covered).toBe(LARGE_AUDIENCE);
		expect(plan.slices).toHaveLength(plan.days);

		// Nothing moved: the campaign keeps the start pre-flight accepted.
		const campaign = await t.run(async (ctx) => await ctx.db.get(campaignId));
		expect(campaign?.status).toBe('scheduled');
		expect(campaign?.scheduledAt).toBe(FITTING_START);
	});

	it('refuses a reschedule after the sender was removed from the allow-list', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedScheduledCampaign(t);
		await t.run(async (ctx) => {
			for (const sender of await ctx.db.query('campaignSenders').collect()) {
				await ctx.db.delete(sender._id);
			}
		});

		const refusal = await refusalOf(
			t.mutation(api.campaigns.scheduling.reschedule, {
				campaignId,
				scheduledAt: FITTING_START + DAY_MS,
			})
		);

		expect(refusal.data?.['reason']).toBe('sender_not_allowed');
	});

	it('refuses a reschedule into the past with the same message as before', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedScheduledCampaign(t);

		const refusal = await refusalOf(
			t.mutation(api.campaigns.scheduling.reschedule, {
				campaignId,
				scheduledAt: MIDNIGHT - HOUR_MS,
			})
		);

		expect(refusal.category).toBe('invalid_state');
		expect(refusal.message).toBe('Scheduled time must be in the future');
		expect(refusal.data?.['reason']).toBe('scheduled_in_past');
	});

	it('patches the fields and schedules the hop for a start that fits', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await seedScheduledCampaign(t);
		const newStart = FITTING_START + DAY_MS;

		await t.mutation(api.campaigns.scheduling.reschedule, {
			campaignId,
			scheduledAt: newStart,
			useRecipientTimezone: true,
			scheduledHour: 9,
			scheduledMinute: 30,
		});

		const campaign = await t.run(async (ctx) => await ctx.db.get(campaignId));
		expect(campaign?.status).toBe('scheduled');
		expect(campaign?.scheduledAt).toBe(newStart);
		expect(campaign?.useRecipientTimezone).toBe(true);
		expect(campaign?.scheduledHour).toBe(9);
		expect(campaign?.scheduledMinute).toBe(30);

		const hops = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(job) =>
					job.name.includes('startCampaignSend') &&
					(job.args[0] as { campaignId?: string } | undefined)?.campaignId === campaignId
			)
		);
		expect(hops.map((job) => job.scheduledTime)).toContain(newStart);
	});
});
