/**
 * "Optimized per contact" scheduling (ADR-0068): the `schedule` /
 * `reschedule` arguments that turn it on, change it and switch it off, the
 * combinations they refuse, and the predicted distribution the schedule panel
 * shows (`campaigns/sendTimeQueries.previewSendTimes`).
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as SessionOrganization from '../lib/sessionOrganization';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
	createTestTopic,
} from './factories';
import { foldEngagement, type SendTimeHistogram } from '../analytics/sendTimeProfile';
import { localTimeParts } from '../lib/emailHelpers';

const sessionMock = vi.hoisted(() => ({
	user: { id: 'test-user', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const { realPermissionGate } = await import('./helpers/permissionGateMock');
	const gate = realPermissionGate(actual, () => sessionMock.user.role);
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.user.id),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireOrgPermission: vi
			.fn()
			.mockImplementation(async (_ctx: unknown, permission: string, message?: string) => {
				gate(permission, message);
				return { userId: sessionMock.user.id, role: sessionMock.user.role };
			}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const HOUR = 60 * 60 * 1000;
const OPTIMIZED = { windowHours: 24, holdoutPercent: 10 };

function setupTest(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

beforeEach(() => {
	sessionMock.user.role = 'owner';
	// Pre-flight refuses without a configured delivery provider.
	process.env['EMAIL_PROVIDER'] = 'mta';
	process.env['MTA_API_URL'] = 'http://mta:3100';
	process.env['MTA_API_KEY'] = 'test-key';
});

afterEach(() => {
	delete process.env['EMAIL_PROVIDER'];
	delete process.env['MTA_API_URL'];
	delete process.env['MTA_API_KEY'];
});

/** A campaign that passes pre-flight, with `contacts` topic members. */
async function seedCampaign(
	t: TestConvex<typeof schema>,
	overrides: Record<string, unknown> = {},
	contacts: Record<string, unknown>[] = []
): Promise<{ campaignId: Id<'campaigns'>; contactIds: Id<'contacts'>[] }> {
	return await t.run(async (ctx) => {
		const emailTemplateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'verified.example.com',
				status: 'verified',
				lastVerifiedAt: Date.now(),
			})
		);
		await ctx.db.insert(
			'campaignSenders',
			createTestCampaignSender({ email: 'sender@verified.example.com' })
		);
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		const contactIds: Id<'contacts'>[] = [];
		for (const [i, contact] of contacts.entries()) {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: `c${i}@example.com`, ...contact }) as never
			);
			contactIds.push(contactId);
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
		}
		const campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'draft',
				emailTemplateId,
				fromEmail: 'sender@verified.example.com',
				audience: { kind: 'topic', topicId },
				...overrides,
			}) as never
		);
		return { campaignId, contactIds };
	});
}

const getCampaign = (t: TestConvex<typeof schema>, id: Id<'campaigns'>) =>
	t.run(async (ctx) => ctx.db.get(id));

describe('scheduling "Optimized per contact"', () => {
	it('schedules a draft with its settings and the start wall-clock time', async () => {
		const t = setupTest();
		const { campaignId } = await seedCampaign(t);
		await t.mutation(api.campaigns.scheduling.schedule, {
			campaignId,
			scheduledAt: Date.now() + 24 * HOUR,
			useRecipientTimezone: false,
			scheduledHour: 9,
			scheduledMinute: 30,
			sendTimeOptimization: OPTIMIZED,
		});
		const campaign = await getCampaign(t, campaignId);
		expect(campaign?.status).toBe('scheduled');
		expect(campaign?.sendTimeOptimization).toEqual(OPTIMIZED);
		expect(campaign?.scheduledHour).toBe(9);
		expect(campaign?.useRecipientTimezone).toBe(false);
	});

	it('clears a leftover choice when a draft is scheduled without it', async () => {
		const t = setupTest();
		const { campaignId } = await seedCampaign(t, { sendTimeOptimization: OPTIMIZED });
		await t.mutation(api.campaigns.scheduling.schedule, {
			campaignId,
			scheduledAt: Date.now() + 24 * HOUR,
		});
		expect((await getCampaign(t, campaignId))?.sendTimeOptimization).toBeUndefined();
	});

	it('changes, keeps and switches off the settings on reschedule', async () => {
		const t = setupTest();
		const { campaignId } = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
			sendTimeOptimization: OPTIMIZED,
		});

		await t.mutation(api.campaigns.scheduling.reschedule, {
			campaignId,
			scheduledAt: Date.now() + 24 * HOUR,
			sendTimeOptimization: { windowHours: 12, holdoutPercent: 0 },
		});
		expect((await getCampaign(t, campaignId))?.sendTimeOptimization).toEqual({
			windowHours: 12,
			holdoutPercent: 0,
		});

		await t.mutation(api.campaigns.scheduling.reschedule, {
			campaignId,
			scheduledAt: Date.now() + 30 * HOUR,
		});
		expect((await getCampaign(t, campaignId))?.sendTimeOptimization).toEqual({
			windowHours: 12,
			holdoutPercent: 0,
		});

		await t.mutation(api.campaigns.scheduling.reschedule, {
			campaignId,
			scheduledAt: Date.now() + 30 * HOUR,
			sendTimeOptimization: null,
		});
		expect((await getCampaign(t, campaignId))?.sendTimeOptimization).toBeUndefined();

		const audits = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('action'), 'campaign.scheduled'))
				.collect()
		);
		expect(
			audits.map((a) => (a.details as { sendTimeOptimized?: boolean }).sendTimeOptimized)
		).toEqual([true, true, false]);
	});

	it('refuses settings out of bounds', async () => {
		const t = setupTest();
		const { campaignId } = await seedCampaign(t);
		for (const settings of [
			{ windowHours: 0, holdoutPercent: 10 },
			{ windowHours: 96, holdoutPercent: 10 },
			{ windowHours: 24, holdoutPercent: 60 },
		]) {
			await expect(
				t.mutation(api.campaigns.scheduling.schedule, {
					campaignId,
					scheduledAt: Date.now() + 24 * HOUR,
					sendTimeOptimization: settings,
				})
			).rejects.toThrow();
		}
		expect((await getCampaign(t, campaignId))?.status).toBe('draft');
	});

	it("refuses it together with the recipient's local time", async () => {
		const t = setupTest();
		const { campaignId } = await seedCampaign(t);
		await expect(
			t.mutation(api.campaigns.scheduling.schedule, {
				campaignId,
				scheduledAt: Date.now() + 24 * HOUR,
				useRecipientTimezone: true,
				scheduledHour: 9,
				scheduledMinute: 0,
				sendTimeOptimization: OPTIMIZED,
			})
		).rejects.toThrow(/local time/);

		// Turning local time on for an optimized campaign is the same conflict.
		const scheduled = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
			sendTimeOptimization: OPTIMIZED,
		});
		await expect(
			t.mutation(api.campaigns.scheduling.reschedule, {
				campaignId: scheduled.campaignId,
				scheduledAt: Date.now() + 24 * HOUR,
				useRecipientTimezone: true,
				scheduledHour: 9,
				scheduledMinute: 0,
			})
		).rejects.toThrow(/local time/);
	});

	it('refuses it on an A/B test', async () => {
		const t = setupTest();
		const { campaignId } = await seedCampaign(t, { isABTest: true });
		await expect(
			t.mutation(api.campaigns.scheduling.schedule, {
				campaignId,
				scheduledAt: Date.now() + 24 * HOUR,
				sendTimeOptimization: OPTIMIZED,
			})
		).rejects.toThrow(/A\/B/);
	});
});

/** `n` opens at a local hour on the start's weekday. */
function habit(hour: number, weekday: number, n: number, at: number): SendTimeHistogram {
	let h: SendTimeHistogram | null = null;
	for (let i = 0; i < n; i++) h = foldEngagement(h, { at, kind: 'open', hour, weekday });
	return h!;
}

describe('the predicted distribution', () => {
	it('places each contact by their profile, the organization, the start time or the holdout', async () => {
		const t = setupTest();
		// Tomorrow 06:00 UTC, so 19:00 in Berlin is inside a 24-hour window.
		const tomorrow = new Date(Date.now() + 24 * HOUR);
		const startAt = Date.UTC(
			tomorrow.getUTCFullYear(),
			tomorrow.getUTCMonth(),
			tomorrow.getUTCDate(),
			6,
			0
		);
		const weekday = localTimeParts(startAt, 'Europe/Berlin').weekday;
		const profile = { ...habit(19, weekday, 5, startAt), timeZone: 'Europe/Berlin' };
		const { campaignId } = await seedCampaign(t, {}, [
			{ timezone: 'Europe/Berlin', sendTimeProfile: profile },
			{ timezone: 'Europe/Berlin' },
			{ timezone: 'Europe/Berlin' },
		]);

		const preview = await t.query(api.campaigns.sendTimeQueries.previewSendTimes, {
			campaignId,
			startAt,
			windowHours: 24,
			holdoutPercent: 0,
			scheduledHour: 7,
			scheduledMinute: 0,
		});
		expect(preview.sampleSize).toBe(3);
		expect(preview.isSample).toBe(false);
		expect(preview.hours).toHaveLength(24);
		expect(preview.sources).toEqual({ contact: 1, organization: 0, start: 2, holdout: 0 });
		expect(preview.organizationBestHour).toBeNull();
		// 19:00 Berlin (UTC+1/+2) is 17:00 or 18:00 UTC; 07:00 Berlin is 05:00 or
		// 06:00 UTC, i.e. at the start or the next morning.
		const busy = preview.hours.filter((h) => h.count > 0);
		expect(busy.reduce((sum, h) => sum + h.count, 0)).toBe(3);
		const profileHour = busy.find((h) => localTimeParts(h.at, 'Europe/Berlin').hour === 19);
		expect(profileHour?.count).toBe(1);
	});

	it('uses the organization histogram for contacts without history once it has enough', async () => {
		const t = setupTest();
		const startAt = Date.now() + 24 * HOUR;
		const { campaignId } = await seedCampaign(t, {}, [{ timezone: 'UTC' }, { timezone: 'UTC' }]);
		await t.run(async (ctx) => {
			await ctx.db.insert('sendTimeHistogramShards', {
				shardKey: 0,
				...habit(14, localTimeParts(startAt, 'UTC').weekday, 30, startAt),
			});
		});
		const preview = await t.query(api.campaigns.sendTimeQueries.previewSendTimes, {
			campaignId,
			startAt,
			windowHours: 24,
			holdoutPercent: 0,
		});
		expect(preview.sources.organization).toBe(2);
		expect(preview.organizationBestHour).toBe(14);
		const busy = preview.hours.filter((h) => h.count > 0);
		expect(busy).toHaveLength(1);
		expect(localTimeParts(busy[0]!.at, 'UTC').hour).toBe(14);
	});

	it('names no busiest hour before the organization histogram is used, and ignores an impossible start time', async () => {
		const t = setupTest();
		const startAt = Date.now() + 24 * HOUR;
		const { campaignId } = await seedCampaign(t, {}, [{ timezone: 'UTC' }]);
		await t.run(async (ctx) => {
			await ctx.db.insert('sendTimeHistogramShards', {
				shardKey: 0,
				...habit(14, localTimeParts(startAt, 'UTC').weekday, 5, startAt),
			});
		});
		const preview = await t.query(api.campaigns.sendTimeQueries.previewSendTimes, {
			campaignId,
			startAt,
			windowHours: 24,
			holdoutPercent: 0,
			scheduledHour: 30,
			scheduledMinute: 0,
		});
		expect(preview.organizationBestHour).toBeNull();
		expect(preview.sources).toEqual({ contact: 0, organization: 0, start: 1, holdout: 0 });
		expect(preview.hours[0]!.count).toBe(1);
	});

	it("starts the bars on the viewer's hours in a half-hour zone", async () => {
		const t = setupTest();
		// Tomorrow 03:00 UTC is 08:30 in Kolkata (UTC+5:30, no DST).
		const tomorrow = new Date(Date.now() + 24 * HOUR);
		const startAt = Date.UTC(
			tomorrow.getUTCFullYear(),
			tomorrow.getUTCMonth(),
			tomorrow.getUTCDate(),
			3,
			0
		);
		const weekday = localTimeParts(startAt, 'Asia/Kolkata').weekday;
		const profile = { ...habit(9, weekday, 5, startAt), timeZone: 'Asia/Kolkata' };
		const { campaignId } = await seedCampaign(t, {}, [
			{ timezone: 'Asia/Kolkata', sendTimeProfile: profile },
		]);
		const args = { campaignId, startAt, windowHours: 6, holdoutPercent: 0 };

		const viewer = await t.query(api.campaigns.sendTimeQueries.previewSendTimes, {
			...args,
			timeZone: 'Asia/Kolkata',
		});
		expect(localTimeParts(viewer.hours[0]!.at, 'Asia/Kolkata')).toMatchObject({
			hour: 8,
			minute: 0,
		});
		const busy = viewer.hours.filter((h) => h.count > 0);
		expect(busy).toHaveLength(1);
		// The 09:00 send sits in the bar labelled 9, not in an 8:30 one.
		expect(localTimeParts(busy[0]!.at, 'Asia/Kolkata')).toMatchObject({ hour: 9, minute: 0 });

		// Without a (valid) zone the bars fall back to UTC hours.
		const fallback = await t.query(api.campaigns.sendTimeQueries.previewSendTimes, {
			...args,
			timeZone: 'Not/AZone',
		});
		expect(fallback.hours[0]!.at).toBe(startAt);
	});

	it('is empty for a campaign without an audience and refuses bad settings', async () => {
		const t = setupTest();
		const { campaignId } = await seedCampaign(t, { audience: undefined });
		const preview = await t.query(api.campaigns.sendTimeQueries.previewSendTimes, {
			campaignId,
			startAt: Date.now() + HOUR,
			windowHours: 6,
			holdoutPercent: 10,
		});
		expect(preview.sampleSize).toBe(0);
		// Six hours from a start that is not on the hour touch seven clock hours.
		expect(preview.hours.length).toBeGreaterThanOrEqual(6);
		expect(preview.hours.length).toBeLessThanOrEqual(7);
		await expect(
			t.query(api.campaigns.sendTimeQueries.previewSendTimes, {
				campaignId,
				startAt: Date.now() + HOUR,
				windowHours: 500,
				holdoutPercent: 10,
			})
		).rejects.toThrow();
	});
});
