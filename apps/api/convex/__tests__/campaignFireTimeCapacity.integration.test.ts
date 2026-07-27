/**
 * The fire-time consequence of the P0-5 capacity gate.
 *
 * `startCampaignSend` turns any pre-flight failure into `{ skipped: true }` and
 * leaves the campaign `scheduled`, which the per-minute cron then re-skips
 * every minute — no lifecycle transition, no audit entry, no notification, and
 * (until P3-7) no way for an operator to accept a multi-day plan. A capacity
 * refusal there would therefore trade "the tail silently expires" for "the
 * campaign silently never starts".
 *
 * So the gate is a pre-flight-TIME decision only. This test drives the real
 * orchestrator action against a campaign the schedule-time gate REFUSES and
 * asserts the campaign's resulting state: it leaves `scheduled` and starts
 * sending, exactly as it did before P0-5.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
	createTestTopic,
} from './factories';
import { MIDNIGHT, runPreflight, seedWarmingState, useMtaPreflightEnv } from './preflightFixtures';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock } = await import('./preflightFixtures');
	return await sessionOrganizationMock();
});

const allModules = import.meta.glob('../**/*.*s');
// Same `'use node'` exclusions the orchestrator suite uses for provider /
// workpool dependencies that are not bootstrapped in convex-test.
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool')
	)
);

useMtaPreflightEnv();

async function seedScheduledOversizedCampaign(
	t: TestConvex<typeof schema>
): Promise<Id<'campaigns'>> {
	let campaignId: Id<'campaigns'>;
	await t.run(async (ctx) => {
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
		const templateId = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'published',
				subject: 'Hello',
				htmlContent: '<p>Hello there</p>',
				defaultLanguage: 'en',
			})
		);
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		for (let i = 0; i < 600; i += 1) {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: `person-${i}@subscriber.example.com`,
					doiStatus: 'not_required',
				})
			);
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: MIDNIGHT });
		}
		campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'scheduled',
				scheduledAt: MIDNIGHT - 60_000,
				emailTemplateId: templateId,
				fromEmail: 'sender@verified.example.com',
				subject: undefined,
				audience: { kind: 'topic', topicId },
				isABTest: false,
			})
		);
	});
	return campaignId!;
}

describe('startCampaignSend — a campaign the capacity gate would refuse still fires', () => {
	it('leaves `scheduled` and is never skipped for capacity', async () => {
		const t = convexTest(schema, modules);
		await seedWarmingState(t);
		const campaignId = await seedScheduledOversizedCampaign(t);

		// The schedule-time gate REFUSES this campaign: 600 recipients against a
		// day-1 IP projecting 0 / 100 / 200 / 200 inside the retention horizon.
		const atScheduleTime = await runPreflight(t, campaignId);
		expect(atScheduleTime.ok).toBe(false);
		if (!atScheduleTime.ok) expect(atScheduleTime.reason).toBe('exceeds_sending_capacity');

		// Downstream of the pre-flight the orchestrator reaches provider/workpool
		// infrastructure convex-test does not bootstrap, so a later throw is not
		// the subject here — the campaign's resulting STATE is.
		const result = await t
			.action(internal.campaigns.send.startCampaignSend, { campaignId })
			.catch(() => undefined);

		if (result) {
			expect(result.skipped ?? false).toBe(false);
			expect(result.reason ?? '').not.toMatch(/capacity/i);
		}

		const status = await t.run(async (ctx) => (await ctx.db.get(campaignId))?.status);
		expect(status).toBe('sending');
	});
});
