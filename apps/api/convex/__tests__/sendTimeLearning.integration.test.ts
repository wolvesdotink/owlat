/**
 * Send-time optimization against a real database (ADR-0068):
 *
 *   - a reader open or click folds into the contact's profile and the
 *     organization histogram, through the send lifecycle;
 *   - an optimized send's delivered / opened / clicked land on its arm's
 *     comparison counters;
 *   - migration 0064 rebuilds profiles from existing sends, leaving out
 *     campaigns that counted automated opens and clicks;
 *   - the send walker tags each send with its arm and schedules its enqueue at
 *     the proposed instant.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestContact,
	createTestDomain,
	createTestEmailSend,
	createTestEmailTemplate,
	createTestTopic,
} from './factories';
import { rollupCampaignStatsRow } from '../campaigns/statShards';
import { readOrganizationHistogram } from '../analytics/sendTimeProfileSync';
import { foldEngagement, peakHour, type SendTimeHistogram } from '../analytics/sendTimeProfile';
import { localTimeParts } from '../lib/emailHelpers';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');
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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Wednesday 2026-03-11 10:00 UTC.
const NOW = Date.UTC(2026, 2, 11, 10, 0);

type Harness = TestConvex<typeof schema>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

const drain = (t: Harness) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function seedSend(
	t: Harness,
	send: Record<string, unknown> = {},
	contact: Record<string, unknown> = { timezone: 'Europe/Berlin' }
): Promise<{ campaignId: Id<'campaigns'>; contactId: Id<'contacts'>; sendId: Id<'emailSends'> }> {
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sent' }));
		const contactId = await ctx.db.insert('contacts', createTestContact(contact) as never);
		const sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				status: 'delivered',
				sentAt: NOW - 2 * HOUR,
				deliveredAt: NOW - 2 * HOUR,
				...send,
			}) as never
		);
		return { campaignId, contactId, sendId };
	});
}

const getContact = (t: Harness, id: Id<'contacts'>) => t.run((ctx) => ctx.db.get(id));

describe('learning from reader engagement', () => {
	it("folds a reader open into the contact's profile in their zone, and into the organization", async () => {
		const t = convexTest(schema, modules);
		const { contactId, sendId } = await seedSend(t);

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'opened', at: NOW, agent: 'client' },
		});
		await drain(t);

		const profile = (await getContact(t, contactId))?.sendTimeProfile;
		expect(profile?.timeZone).toBe('Europe/Berlin');
		// 10:00 UTC is 11:00 in Berlin in March.
		expect(profile?.hours[11]).toBe(1);
		expect(profile?.days[3]).toBe(1);
		expect(profile?.total).toBe(1);

		const organization = await t.run((ctx) => readOrganizationHistogram(ctx.db));
		expect(organization?.hours[11]).toBe(1);
	});

	it('weighs a click double and ignores an Apple Mail Privacy Protection fetch', async () => {
		const t = convexTest(schema, modules);
		const { contactId, sendId } = await seedSend(t, {}, { timezone: undefined });

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'opened', at: NOW, agent: 'apple_proxy' },
		});
		await drain(t);
		expect((await getContact(t, contactId))?.sendTimeProfile).toBeUndefined();

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'clicked', at: NOW + HOUR, url: 'https://example.com', agent: 'client' },
		});
		await drain(t);
		const profile = (await getContact(t, contactId))?.sendTimeProfile;
		// No zone on the contact and none for the organization: UTC.
		expect(profile?.timeZone).toBe('UTC');
		expect(profile?.hours[11]).toBe(2);
	});

	it("buckets in the organization's zone for a contact without one", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				timezone: 'America/New_York',
				createdAt: NOW,
				updatedAt: NOW,
			} as never);
		});
		const { contactId } = await seedSend(t, {}, { timezone: undefined });
		await t.mutation(internal.analytics.sendTimeProfileSync.recordEngagement, {
			contactId,
			engagement: 'open',
			at: NOW,
		});
		const profile = (await getContact(t, contactId))?.sendTimeProfile;
		expect(profile?.timeZone).toBe('America/New_York');
		expect(profile?.hours[6]).toBe(1);
	});

	it('does nothing for a contact that is gone', async () => {
		const t = convexTest(schema, modules);
		const { contactId } = await seedSend(t);
		await t.run((ctx) => ctx.db.delete(contactId));
		await t.mutation(internal.analytics.sendTimeProfileSync.recordEngagement, {
			contactId,
			engagement: 'click',
			at: NOW,
		});
		expect(await t.run((ctx) => readOrganizationHistogram(ctx.db))).toBeNull();
	});
});

describe('comparison counters', () => {
	it("counts an optimized send's delivered, open and click on its arm", async () => {
		const t = convexTest(schema, modules);
		const { campaignId, sendId } = await seedSend(t, {
			status: 'sent',
			deliveredAt: undefined,
			sendTimeGroup: 'holdout',
		});
		const ref = { kind: 'campaign' as const, id: sendId };
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: ref,
			transition: { to: 'delivered', at: NOW - HOUR },
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: ref,
			transition: { to: 'opened', at: NOW, agent: 'client' },
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: ref,
			transition: { to: 'clicked', at: NOW + 60_000, url: 'https://example.com', agent: 'client' },
		});
		await drain(t);
		const campaign = await t.run(async (ctx) => {
			const c = await ctx.db.get(campaignId);
			await rollupCampaignStatsRow(ctx, c!);
			return await ctx.db.get(campaignId);
		});
		expect(campaign).toMatchObject({
			statsDelivered: 1,
			statsOpened: 1,
			statsClicked: 1,
			statsSendTimeHoldoutDelivered: 1,
			statsSendTimeHoldoutOpened: 1,
			statsSendTimeHoldoutClicked: 1,
			statsSendTimeOptimizedDelivered: 0,
		});
	});
});

describe('migration 0064', () => {
	const migration = internal.migrations['0064_backfill_send_time_profiles'];

	it('rebuilds profiles and the organization histogram from filtered campaigns only', async () => {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const filtered = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'sent',
					isAutomatedOpenFiltered: true,
					isAutomatedClickFiltered: true,
				})
			);
			const legacy = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sent' }));
			const reader = await ctx.db.insert(
				'contacts',
				createTestContact({ timezone: 'Europe/Berlin' }) as never
			);
			const silent = await ctx.db.insert('contacts', createTestContact() as never);
			// A stale profile that the rebuild must drop: no filtered events back it.
			await ctx.db.patch(silent, {
				sendTimeProfile: {
					...foldEngagement(null, { at: NOW, kind: 'open', hour: 3, weekday: 1 }),
					timeZone: 'UTC',
				},
			});
			for (let day = 1; day <= 3; day++) {
				await ctx.db.insert(
					'emailSends',
					createTestEmailSend({
						campaignId: filtered,
						contactId: reader,
						status: 'clicked',
						openedAt: NOW - day * DAY - 2 * HOUR, // 08:00 UTC = 09:00 Berlin
						clickedAt: NOW - day * DAY - 2 * HOUR + 60_000,
					}) as never
				);
			}
			// Pre-filter opens may be Apple MPP fetches: never counted.
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId: legacy,
					contactId: reader,
					status: 'opened',
					openedAt: NOW - 5 * DAY + 2 * HOUR,
				}) as never
			);
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId: legacy,
					contactId: silent,
					status: 'opened',
					openedAt: NOW - DAY,
				}) as never
			);
			return { reader, silent };
		});

		expect(await t.mutation(migration.run, {})).toEqual({ started: true, generation: 1 });
		await drain(t);

		const reader = await getContact(t, ids.reader);
		expect(reader?.sendTimeProfile?.timeZone).toBe('Europe/Berlin');
		// Three opens (1 each) and three clicks (2 each) at 09:00, decayed a little.
		expect(reader?.sendTimeProfile?.hours[9]).toBeGreaterThan(8.5);
		expect(reader?.sendTimeProfile?.hours[9]).toBeLessThan(9);
		// The pre-filter open at 13:00 Berlin is not in it.
		expect(reader?.sendTimeProfile?.hours[13]).toBe(0);
		expect((await getContact(t, ids.silent))?.sendTimeProfile).toBeUndefined();

		const organization = await t.run((ctx) => readOrganizationHistogram(ctx.db));
		expect(peakHour(organization)).toBe(9);

		const run = await t.run((ctx) =>
			ctx.db
				.query('migrationRuns')
				.withIndex('by_migration', (q) => q.eq('migration', '0064_backfill_send_time_profiles'))
				.unique()
		);
		expect(run).toMatchObject({ status: 'completed', scannedCount: 2, changedCount: 2 });

		// A restart rebuilds rather than adds: the same profile, the same histogram.
		const before = organization!.total;
		expect(await t.mutation(migration.run, { restart: true })).toMatchObject({ started: true });
		await drain(t);
		const again = await t.run((ctx) => readOrganizationHistogram(ctx.db));
		expect(again!.total).toBeCloseTo(before, 9);
		expect((await getContact(t, ids.reader))?.sendTimeProfile).toEqual(reader?.sendTimeProfile);
		expect(await t.mutation(migration.run, {})).toMatchObject({ started: false });
	});
});

/** `n` reader opens at one local hour. */
function habit(hour: number, weekday: number, n: number): SendTimeHistogram {
	let h: SendTimeHistogram | null = null;
	for (let i = 0; i < n; i++) h = foldEngagement(h, { at: NOW, kind: 'open', hour, weekday });
	return h!;
}

async function setupOptimizedCampaign(
	t: Harness,
	contacts: Record<string, unknown>[],
	settings = { windowHours: 24, holdoutPercent: 0 }
): Promise<{ campaignId: Id<'campaigns'>; contactIds: Id<'contacts'>[] }> {
	return await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({ domain: 'example.com', status: 'verified', lastVerifiedAt: NOW })
		);
		const template = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'published',
				subject: 'Hello {{firstName}}',
				htmlContent: '<p>Body for {{firstName}}</p>',
				defaultLanguage: 'en',
			})
		);
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		const contactIds: Id<'contacts'>[] = [];
		for (const [i, contact] of contacts.entries()) {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: `o${i}@example.com`,
					doiStatus: 'not_required',
					...contact,
				}) as never
			);
			contactIds.push(contactId);
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: NOW });
		}
		await ctx.db.insert(
			'campaignSenders',
			createTestCampaignSender({ email: 'sender@example.com' })
		);
		const campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'sending',
				sentAt: NOW,
				emailTemplateId: template,
				fromEmail: 'sender@example.com',
				fromName: 'Test Sender',
				audience: { kind: 'topic', topicId },
				subject: undefined,
				isABTest: false,
				scheduledHour: 10,
				scheduledMinute: 0,
				sendTimeOptimization: settings,
			})
		);
		return { campaignId, contactIds };
	});
}

/** PREP opens the walk's checkpoint; the test then drives the page hop itself. */
async function startWalk(t: Harness, campaignId: Id<'campaigns'>) {
	await t.action(internal.campaigns.send.startCampaignSend, { campaignId });
	return await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId });
}

/** The scheduled enqueue chunks: when each fires and for which contacts. */
async function scheduledEnqueues(t: Harness): Promise<Map<string, number>> {
	const jobs = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
	const at = new Map<string, number>();
	for (const job of jobs) {
		if (!job.name.includes('enqueueCampaignEmails')) continue;
		const args = job.args[0] as { emails: { contactId: string }[] };
		for (const email of args.emails) at.set(email.contactId, job.scheduledTime);
	}
	return at;
}

describe('the send walker', () => {
	it("tags each send with its arm and enqueues it at the contact's proposed hour", async () => {
		const t = convexTest(schema, modules);
		const weekday = localTimeParts(NOW, 'Europe/Berlin').weekday;
		const { campaignId, contactIds } = await setupOptimizedCampaign(t, [
			{
				timezone: 'Europe/Berlin',
				sendTimeProfile: { ...habit(19, weekday, 5), timeZone: 'Europe/Berlin' },
			},
			{ timezone: 'America/New_York' },
		]);

		const result = await startWalk(t, campaignId);
		expect(result.pageEnqueued).toBe(2);

		const sends = await t.run((ctx) =>
			ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
				.collect()
		);
		expect(sends.map((s: Doc<'emailSends'>) => s.sendTimeGroup)).toEqual([
			'optimized',
			'optimized',
		]);

		const at = await scheduledEnqueues(t);
		// The reader of evening mail: 19:00 in Berlin today.
		expect(localTimeParts(at.get(contactIds[0]!)!, 'Europe/Berlin')).toMatchObject({
			hour: 19,
			minute: 0,
		});
		// No history anywhere: the start's wall clock (10:00) in New York.
		expect(localTimeParts(at.get(contactIds[1]!)!, 'America/New_York')).toMatchObject({
			hour: 10,
			minute: 0,
		});
	});

	it('sends the comparison group at the start', async () => {
		const t = convexTest(schema, modules);
		const contacts = Array.from({ length: 40 }, () => ({ timezone: 'Asia/Tokyo' }));
		const { campaignId } = await setupOptimizedCampaign(t, contacts, {
			windowHours: 24,
			holdoutPercent: 50,
		});
		await startWalk(t, campaignId);

		const sends = await t.run((ctx) =>
			ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
				.collect()
		);
		const holdout = sends.filter((s: Doc<'emailSends'>) => s.sendTimeGroup === 'holdout');
		expect(holdout.length).toBeGreaterThan(5);
		expect(holdout.length).toBeLessThan(35);
		const at = await scheduledEnqueues(t);
		for (const send of holdout) expect(at.get(send.contactId)).toBe(NOW);
		for (const send of sends.filter((s: Doc<'emailSends'>) => s.sendTimeGroup === 'optimized')) {
			expect(localTimeParts(at.get(send.contactId)!, 'Asia/Tokyo')).toMatchObject({ hour: 10 });
		}
	});
});
