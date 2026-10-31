/**
 * What one hop of the campaign send walker (`resolveCampaignPage`) and the A/B
 * winner phase (`sendCampaignWinnerToRemainder`) leave behind: the send rows,
 * the scheduled enqueue chunks and their send instants, the job checkpoint, the
 * day's plan line, the daily send count, the next hop and the completion.
 *
 * Scheduled work is held on fake timers and read back from
 * `_scheduled_functions`; each hop is driven explicitly.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
	createTestSegment,
	createTestTopic,
} from './factories';
import { readInstanceCounter } from '../lib/instanceCounters';
import { resolveNextSendTime } from '../lib/emailHelpers';
import { testFractionForSplit } from '../campaigns/sendVariantSplit';

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

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

type Harness = TestConvex<typeof schema>;

const ENQUEUE = 'delivery/enqueue:enqueueCampaignEmails';
const HOP = 'campaigns/send:resolveCampaignPage';

interface SeedOptions {
	recipients: number;
	timezones?: string[];
	campaign?: Record<string, unknown>;
	segment?: boolean;
}

async function seedSending(
	t: Harness,
	options: SeedOptions
): Promise<{ campaignId: Id<'campaigns'>; templateId: Id<'emailTemplates'> }> {
	return await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', { createdAt: Date.now() });
		await ctx.db.insert(
			'domains',
			createTestDomain({ domain: 'example.com', status: 'verified', lastVerifiedAt: Date.now() })
		);
		await ctx.db.insert(
			'campaignSenders',
			createTestCampaignSender({ email: 'sender@example.com' })
		);
		const templateId = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'published',
				subject: 'Hello {{firstName}}',
				htmlContent: '<p>Body for {{firstName}}</p>',
				defaultLanguage: 'en',
			})
		);
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		for (let i = 0; i < options.recipients; i++) {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: `w${i}@example.com`,
					firstName: `First${i}`,
					doiStatus: 'not_required',
					timezone: options.timezones?.[i % options.timezones.length] ?? 'UTC',
				})
			);
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
		}
		const audience = options.segment
			? {
					kind: 'segment' as const,
					segmentId: await ctx.db.insert('segments', createTestSegment()),
				}
			: { kind: 'topic' as const, topicId };
		const campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'sending',
				sentAt: Date.now(),
				emailTemplateId: templateId,
				fromEmail: 'sender@example.com',
				fromName: 'Test Sender',
				audience,
				subject: undefined,
				isABTest: false,
				...options.campaign,
			})
		);
		return { campaignId, templateId };
	});
}

interface Pending {
	id: string;
	name: string;
	scheduledTime: number;
	args: Record<string, unknown>;
}

async function pendingScheduled(t: Harness): Promise<Pending[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.state.kind === 'pending')
			.map((job) => ({
				id: String(job._id),
				name: job.name,
				scheduledTime: job.scheduledTime,
				args: job.args[0] as Record<string, unknown>,
			}))
	);
}

/** The scheduled functions a step added, by diffing the pending set around it. */
async function scheduledBy(t: Harness, step: () => Promise<unknown>): Promise<Pending[]> {
	const before = new Set((await pendingScheduled(t)).map((job) => job.id));
	await step();
	return (await pendingScheduled(t)).filter((job) => !before.has(job.id));
}

async function readState(t: Harness, campaignId: Id<'campaigns'>) {
	return await t.run(async (ctx) => ({
		campaign: await ctx.db.get(campaignId),
		job: await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
			.first(),
		sends: await ctx.db
			.query('emailSends')
			.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
			.collect(),
		daily: (await readInstanceCounter(ctx.db, 'sends')).dailySendCount,
	}));
}

function hop(t: Harness, campaignId: Id<'campaigns'>) {
	return t.action(internal.campaigns.send.resolveCampaignPage, { campaignId });
}

describe('resolveCampaignPage — what one page hop writes', () => {
	it('the last page: rows, one enqueue, the done checkpoint, the plan day and the daily count', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, { recipients: 3 });
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId });

		let result: unknown;
		const scheduled = await scheduledBy(t, async () => {
			result = await hop(t, campaignId);
		});

		expect(result).toEqual({ done: true, pageEnqueued: 3 });
		const state = await readState(t, campaignId);
		expect(state.sends).toHaveLength(3);
		expect(state.sends.every((send) => send.status === 'queued')).toBe(true);
		expect(state.sends.map((send) => send.personalizedSubject).sort()).toEqual([
			'Hello First0',
			'Hello First1',
			'Hello First2',
		]);
		expect(scheduled.map((job) => job.name)).toEqual([ENQUEUE]);
		const enqueue = scheduled[0]!.args;
		expect(enqueue).toMatchObject({
			campaignId,
			from: 'Test Sender <sender@example.com>',
			subject: 'Hello {{firstName}}',
			htmlContent: '<p>Body for {{firstName}}</p>',
			audienceType: 'topic',
		});
		const emails = enqueue['emails'] as Array<{ emailSendId: string; email: string }>;
		expect(emails.map((email) => email.email).sort()).toEqual([
			'w0@example.com',
			'w1@example.com',
			'w2@example.com',
		]);
		expect(new Set(emails.map((email) => email.emailSendId))).toEqual(
			new Set(state.sends.map((send) => String(send._id)))
		);
		expect(state.job).toMatchObject({
			phase: 'done',
			enqueuedCount: 3,
			totalCandidates: 3,
			enqueuedToday: 3,
		});
		expect(state.job?.planDayKey).toBeTypeOf('string');
		expect(state.job?.resumeAt).toBeUndefined();
		expect(state.daily).toBe(3);
		// Not the empty-audience fast path: completion waits for the sends.
		expect(state.campaign?.status).toBe('sending');
	});

	it('enqueues a page in chunks of fifty recipients', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, { recipients: 120 });
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId });

		const scheduled = await scheduledBy(t, () => hop(t, campaignId));

		const chunks = scheduled.filter((job) => job.name === ENQUEUE);
		expect(chunks.map((job) => (job.args['emails'] as unknown[]).length).sort()).toEqual([
			20, 50, 50,
		]);
		expect(scheduled.filter((job) => job.name === HOP)).toHaveLength(0);
	});

	it('a page with more to come advances the cursor and schedules the next hop', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, { recipients: 520 });
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId });

		let result: unknown;
		const scheduled = await scheduledBy(t, async () => {
			result = await hop(t, campaignId);
		});

		expect(result).toEqual({ done: false, pageEnqueued: 500 });
		expect(scheduled.filter((job) => job.name === HOP)).toHaveLength(1);
		const state = await readState(t, campaignId);
		expect(state.sends).toHaveLength(500);
		expect(state.job).toMatchObject({ phase: 'resolving', enqueuedCount: 500 });
		expect(state.job?.cursor).not.toBe('');
		expect(state.daily).toBe(500);
	});

	it('schedules a timezone-aware page per zone at its local send hour', async () => {
		const t = convexTest(schema, modules);
		const zones = ['America/New_York', 'Asia/Tokyo'];
		const { campaignId } = await seedSending(t, {
			recipients: 4,
			timezones: zones,
			campaign: { useRecipientTimezone: true, scheduledHour: 9, scheduledMinute: 30 },
		});
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId });

		const now = Date.now();
		const scheduled = await scheduledBy(t, () => hop(t, campaignId));

		const chunks = scheduled.filter((job) => job.name === ENQUEUE);
		expect(chunks).toHaveLength(2);
		const byInstant = new Map(
			chunks.map((job) => [job.scheduledTime, (job.args['emails'] as unknown[]).length])
		);
		expect(byInstant).toEqual(
			new Map(zones.map((zone) => [resolveNextSendTime(zone, 9, 30, now), 2]))
		);
	});

	it('an empty audience completes the campaign in the same hop', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, { recipients: 0 });
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId });

		const scheduled = await scheduledBy(t, () => hop(t, campaignId));

		expect(scheduled.filter((job) => job.name === ENQUEUE || job.name === HOP)).toEqual([]);
		const state = await readState(t, campaignId);
		expect(state.campaign?.status).toBe('sent');
		expect(state.job).toMatchObject({ phase: 'done', enqueuedCount: 0 });
		// A page that enqueued nobody leaves the daily count alone.
		expect(state.daily).toBeUndefined();
	});
});

describe('commitCampaignPage — a hop that lost its race writes nothing', () => {
	async function preparedJob(t: Harness, campaignId: Id<'campaigns'>) {
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId });
		const { job } = await readState(t, campaignId);
		return job!;
	}

	function commit(
		t: Harness,
		campaignId: Id<'campaigns'>,
		read: { startedAt: number; cursor: string }
	) {
		return t.mutation(internal.campaigns.walkerCommit.commitCampaignPage, {
			campaignId,
			read,
			buckets: [
				{
					envelope: { from: 'sender@example.com', subject: 'Hi', htmlContent: '<p>Hi</p>' },
					groups: [{ recipients: [] }],
				},
			],
			page: { nextCursor: 'next', pageCandidates: 1 },
			planDay: {
				planDayKey: '2026-10-31',
				enqueuedToday: 0,
				planDayIndex: 0,
				planTotalDays: 1,
				isPlanTruncated: false,
			},
		});
	}

	it('another hop already advanced the cursor', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, { recipients: 1 });
		const job = await preparedJob(t, campaignId);

		const scheduled = await scheduledBy(t, async () => {
			expect(
				await commit(t, campaignId, { startedAt: job.startedAt, cursor: 'elsewhere' })
			).toEqual({ kind: 'stale', reason: 'Another hop moved the walk during this one' });
		});

		expect(scheduled).toEqual([]);
		expect((await readState(t, campaignId)).job).toEqual(job);
	});

	it('the walk was reset under the hop', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, { recipients: 1 });
		const job = await preparedJob(t, campaignId);

		const result = await commit(t, campaignId, { startedAt: job.startedAt - 1, cursor: '' });

		expect(result.kind).toBe('stale');
		expect((await readState(t, campaignId)).job).toEqual(job);
	});

	it('the campaign left sending during the hop', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, { recipients: 1 });
		const job = await preparedJob(t, campaignId);
		await t.run(async (ctx) => ctx.db.patch(campaignId, { status: 'draft' }));

		const scheduled = await scheduledBy(t, async () => {
			expect(await commit(t, campaignId, { startedAt: job.startedAt, cursor: '' })).toEqual({
				kind: 'stale',
				reason: 'The walk stopped during the hop',
			});
		});

		expect(scheduled).toEqual([]);
		expect((await readState(t, campaignId)).job).toEqual(job);
	});

	it("a previous release's advance of a page this release committed counts nothing twice", async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, { recipients: 520 });
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId });
		await hop(t, campaignId);
		const committed = (await readState(t, campaignId)).job!;

		await t.mutation(internal.campaigns.sendJob.advanceSendJob, {
			campaignId,
			nextCursor: committed.cursor,
			pageEnqueued: 500,
			pageCandidates: 500,
		});

		expect((await readState(t, campaignId)).job).toEqual(committed);
	});
});

describe('sendCampaignWinnerToRemainder — what the winner phase writes', () => {
	it('freezes the segment, resets the job to an ab_winner walk and schedules one hop', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, {
			recipients: 2,
			segment: true,
			campaign: {
				isABTest: true,
				abTestStatus: 'winner_selected',
				abWinner: 'B',
				abWinnerSelectedAt: Date.now(),
				abTestConfig: {
					testType: 'subject',
					splitPercentage: 30,
					variantBSubject: 'Variant B {{firstName}}',
					winnerCriteria: 'manual',
				},
			},
		});
		// The test phase's finished walk, which the winner phase resets.
		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(campaignId);
			await ctx.db.insert('campaignSendJobs', {
				campaignId,
				phase: 'done',
				variantMode: 'ab_test',
				testFraction: 0.3,
				splitPercentage: 30,
				cursor: 'test-phase-end',
				audience: campaign!.audience!,
				enqueuedCount: 7,
				totalCandidates: 9,
				planDayKey: '2026-10-30',
				enqueuedToday: 7,
				startedAt: Date.now() - 60_000,
				updatedAt: Date.now() - 60_000,
			});
		});

		let result: unknown;
		const scheduled = await scheduledBy(t, async () => {
			result = await t.action(internal.campaigns.send.sendCampaignWinnerToRemainder, {
				campaignId,
			});
		});

		expect(result).toEqual({ scheduled: true });
		expect(scheduled.map((job) => job.name)).toEqual([HOP]);
		expect(scheduled[0]!.args).toEqual({ campaignId });
		const state = await readState(t, campaignId);
		expect(state.campaign?.audience).toMatchObject({ kind: 'segment' });
		expect(
			state.campaign?.audience?.kind === 'segment' && state.campaign.audience.frozenFilters
		).toBeTruthy();
		expect(state.job).toMatchObject({
			phase: 'resolving',
			variantMode: 'ab_winner',
			winningVariant: 'B',
			splitPercentage: 30,
			testFraction: testFractionForSplit(30),
			cursor: '',
			enqueuedCount: 0,
			totalCandidates: 0,
			audience: state.campaign?.audience,
		});
		expect(state.job?.planDayKey).toBeUndefined();
		expect(state.job?.startedAt).toBe(Date.now());
	});

	it("a previous release's winner-phase reset leaves this release's winner walk alone", async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, {
			recipients: 520,
			campaign: {
				isABTest: true,
				abTestStatus: 'winner_selected',
				abWinner: 'A',
				abTestConfig: {
					testType: 'subject',
					splitPercentage: 50,
					variantBSubject: 'Variant B {{firstName}}',
					winnerCriteria: 'manual',
				},
			},
		});
		await t.action(internal.campaigns.send.sendCampaignWinnerToRemainder, { campaignId });
		await hop(t, campaignId);
		const walking = (await readState(t, campaignId)).job!;
		expect(walking.cursor).not.toBe('');

		await t.mutation(internal.campaigns.sendJob.createSendJob, {
			campaignId,
			audience: walking.audience,
			variantMode: 'ab_winner',
			testFraction: walking.testFraction,
			splitPercentage: 50,
			winningVariant: 'A',
		});

		expect((await readState(t, campaignId)).job).toEqual(walking);
	});

	it('writes nothing and schedules nothing when the winner is not declared', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seedSending(t, {
			recipients: 2,
			campaign: { isABTest: true, abTestStatus: 'testing' },
		});

		let result: unknown;
		const scheduled = await scheduledBy(t, async () => {
			result = await t.action(internal.campaigns.send.sendCampaignWinnerToRemainder, {
				campaignId,
			});
		});

		expect(result).toMatchObject({ scheduled: false, skipped: true });
		expect(scheduled).toEqual([]);
		expect((await readState(t, campaignId)).job).toBeNull();
	});
});
