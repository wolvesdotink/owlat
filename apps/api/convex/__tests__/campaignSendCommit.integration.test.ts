/**
 * The send preparation commits once (`campaigns/sendCommit.ts`).
 *
 * `startCampaignSend` reads, scans and then hands everything it decided to ONE
 * mutation. These cases pin what that buys: a commit that fails part-way
 * leaves nothing behind, a campaign that moved during the scan is not
 * prepared on a stale read, changed content is scanned again instead of sent
 * on an old verdict, and a second hop cannot reset a prepared send.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { scannedContentDigest } from '../campaigns/sendCommit';
import type * as SendJobModule from '../campaigns/sendJob';
import { type Harness, type Seeded, prepared, seed, start } from './helpers/campaignPreparation';

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

// Opening the send job is the commit's last write before the walker hop. A
// test arms this to make it throw, to see what a late failure leaves behind.
const jobFailure = vi.hoisted(() => ({ armed: false }));
vi.mock('../campaigns/sendJob', async (importOriginal) => {
	const actual = await importOriginal<typeof SendJobModule>();
	return {
		...actual,
		openSendJob: (...args: Parameters<typeof actual.openSendJob>) => {
			if (jobFailure.armed) throw new Error('send job write failed');
			return actual.openSendJob(...args);
		},
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
	jobFailure.armed = false;
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

/** The digest `startCampaignSend` would send for the campaign as stored now. */
async function currentDigest(t: Harness, { campaignId, templateId }: Seeded): Promise<string> {
	const { subject, html } = await t.run(async (ctx) => {
		const campaign = await ctx.db.get(campaignId);
		const template = await ctx.db.get(templateId);
		return {
			subject: campaign?.subject ?? template?.subject ?? '',
			html: template?.htmlContent ?? '',
		};
	});
	return await scannedContentDigest(subject, html);
}

async function commit(
	t: Harness,
	seeded: Seeded,
	read: { status: 'scheduled' | 'sending'; contentDigest: string }
) {
	return await t.mutation(internal.campaigns.sendCommit.commitPreparation, {
		campaignId: seeded.campaignId,
		read: { ...read, templateId: seeded.templateId },
		verdict: { kind: 'proceed' },
	});
}

const NOTHING_PREPARED = { versions: [], jobs: [], scanRows: [] };

describe('send preparation commit — all or nothing', () => {
	it('a failure late in the commit leaves the campaign scheduled with nothing prepared', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled', segment: true });
		jobFailure.armed = true;

		await expect(start(t, seeded.campaignId)).rejects.toThrow(/send job write failed/);

		const state = await prepared(t, seeded);
		expect(state).toMatchObject(NOTHING_PREPARED);
		expect(state.campaign?.status).toBe('scheduled');
		expect(state.campaign?.sentAt).toBeUndefined();
		const audience = state.campaign?.audience;
		expect(audience?.kind === 'segment' ? audience.frozenFilters : 'topic').toBeUndefined();
		expect(state.audits).toEqual([]);
		expect(state.scheduled).toEqual([]);
	});

	it('the same start succeeds once the failure is gone', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });
		jobFailure.armed = true;
		await expect(start(t, seeded.campaignId)).rejects.toThrow();
		jobFailure.armed = false;

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('sending');
		expect(state.jobs).toHaveLength(1);
		expect(state.versions).toHaveLength(1);
	});
});

describe('send preparation commit — re-checks what the action read', () => {
	it('a campaign cancelled during the scan is skipped and nothing is written', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });
		const contentDigest = await currentDigest(t, seeded);
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.campaignId, { status: 'cancelled', cancelledAt: Date.now() });
		});

		const result = await commit(t, seeded, { status: 'scheduled', contentDigest });

		expect(result).toEqual({ kind: 'skipped', reason: 'Campaign was cancelled' });
		const state = await prepared(t, seeded);
		expect(state).toMatchObject(NOTHING_PREPARED);
		expect(state.campaign?.status).toBe('cancelled');
		expect(state.scheduled).toEqual([]);
	});

	it('a campaign another hop already started is skipped', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });
		const contentDigest = await currentDigest(t, seeded);
		await start(t, seeded.campaignId);

		const result = await commit(t, seeded, { status: 'scheduled', contentDigest });

		expect(result).toEqual({
			kind: 'skipped',
			reason: 'Campaign status changed during preparation',
		});
		expect((await prepared(t, seeded)).versions).toHaveLength(1);
	});

	it('a template edited during the scan is scanned again, not sent on the old verdict', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const contentDigest = await currentDigest(t, seeded);
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.templateId, { htmlContent: '<p>Edited after the scan</p>' });
		});

		const result = await commit(t, seeded, { status: 'sending', contentDigest });

		expect(result.kind).toBe('rescan');
		const state = await prepared(t, seeded);
		expect(state).toMatchObject(NOTHING_PREPARED);
		expect(state.scheduled).toEqual(['campaigns/send:startCampaignSend']);
	});

	it('a subject override set during the scan is scanned again', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const contentDigest = await currentDigest(t, seeded);
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.campaignId, { subject: 'A new subject line' });
		});

		const result = await commit(t, seeded, { status: 'sending', contentDigest });

		expect(result.kind).toBe('rescan');
		expect(await prepared(t, seeded)).toMatchObject(NOTHING_PREPARED);
	});

	it('a different template picked during the scan is scanned again', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const contentDigest = await currentDigest(t, seeded);
		const other: Id<'emailTemplates'> = await t.run(async (ctx) => {
			const template = await ctx.db.get(seeded.templateId);
			const { _id, _creationTime, ...fields } = template!;
			return await ctx.db.insert('emailTemplates', fields);
		});
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.campaignId, { emailTemplateId: other });
		});

		const result = await commit(t, seeded, { status: 'sending', contentDigest });

		expect(result.kind).toBe('rescan');
		expect(await prepared(t, seeded)).toMatchObject(NOTHING_PREPARED);
	});
});

describe('send preparation commit — one preparation per send', () => {
	it('a second hop for a prepared send is skipped and leaves the walk alone', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await start(t, seeded.campaignId);
		// The walker has enqueued a page since.
		await t.run(async (ctx) => {
			const job = await ctx.db
				.query('campaignSendJobs')
				.withIndex('by_campaign', (q) => q.eq('campaignId', seeded.campaignId))
				.first();
			await ctx.db.patch(job!._id, { cursor: 'page-2', enqueuedCount: 50 });
		});

		const result = await start(t, seeded.campaignId);

		expect(result).toMatchObject({ skipped: true, reason: 'Campaign send is already prepared' });
		const state = await prepared(t, seeded);
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]).toMatchObject({ cursor: 'page-2', enqueuedCount: 50 });
		expect(state.versions).toHaveLength(1);
	});

	it('the hop the scheduler-tick start schedules finds the send prepared', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });
		await start(t, seeded.campaignId);
		expect((await prepared(t, seeded)).scheduled).toContain('campaigns/send:startCampaignSend');

		const result = await start(t, seeded.campaignId);

		expect(result).toMatchObject({ skipped: true, reason: 'Campaign send is already prepared' });
	});

	it('a job left by an earlier send of the campaign is reset for the new one', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.run(async (ctx) => {
			const campaign = await ctx.db.get(seeded.campaignId);
			await ctx.db.insert('campaignSendJobs', {
				campaignId: seeded.campaignId,
				phase: 'done',
				variantMode: 'plain',
				cursor: 'old-cursor',
				audience: campaign!.audience!,
				enqueuedCount: 9,
				totalCandidates: 9,
				startedAt: campaign!.sentAt! - 60_000,
				updatedAt: campaign!.sentAt! - 60_000,
			});
		});

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]).toMatchObject({ phase: 'resolving', cursor: '', enqueuedCount: 0 });
	});

	it('a scheduled A/B campaign opens its A/B job on the first hop', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled', isABTest: true });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.campaign?.abTestStatus).toBe('testing');
		expect(state.jobs[0]).toMatchObject({ variantMode: 'ab_test', splitPercentage: 20 });
	});

	it('a hop for a campaign held for review is skipped', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.campaignId, { status: 'pending_review' });
		});

		const result = await start(t, seeded.campaignId);

		expect(result).toMatchObject({ skipped: true, reason: expect.stringMatching(/review/) });
		expect(await prepared(t, seeded)).toMatchObject(NOTHING_PREPARED);
	});
});

/** The walker has enqueued a page of the prepared send since. */
async function advanceWalk(t: Harness, { campaignId }: Seeded): Promise<Doc<'campaignSendJobs'>> {
	return await t.run(async (ctx) => {
		const job = await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
			.first();
		await ctx.db.patch(job!._id, { cursor: 'page-2', enqueuedCount: 50 });
		return (await ctx.db.get(job!._id))!;
	});
}

// A preparation action of the previous release, still running during the
// deploy, calls these mutations one by one after its own scan. When the new
// commit has prepared the same send meanwhile, they must not undo it.
describe('send preparation commit — beside a previous-release preparation', () => {
	it('a first-phase createSendJob does not reset the walk the commit started', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });
		await start(t, seeded.campaignId);
		const job = await advanceWalk(t, seeded);

		const jobId = await t.mutation(internal.campaigns.sendJob.createSendJob, {
			campaignId: seeded.campaignId,
			audience: job.audience,
			variantMode: 'plain',
		});

		expect(jobId).toBe(job._id);
		const state = await prepared(t, seeded);
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]).toMatchObject({
			phase: 'resolving',
			cursor: 'page-2',
			enqueuedCount: 50,
		});
	});

	it('a first-phase createSendJob still resets a job left by an earlier send', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const audience = await t.run(async (ctx) => {
			const campaign = await ctx.db.get(seeded.campaignId);
			await ctx.db.insert('campaignSendJobs', {
				campaignId: seeded.campaignId,
				phase: 'done',
				variantMode: 'plain',
				cursor: 'old-cursor',
				audience: campaign!.audience!,
				enqueuedCount: 9,
				totalCandidates: 9,
				startedAt: campaign!.sentAt! - 60_000,
				updatedAt: campaign!.sentAt! - 60_000,
			});
			return campaign!.audience!;
		});

		await t.mutation(internal.campaigns.sendJob.createSendJob, {
			campaignId: seeded.campaignId,
			audience,
		});

		const state = await prepared(t, seeded);
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]).toMatchObject({ phase: 'resolving', cursor: '', enqueuedCount: 0 });
	});

	it('the A/B winner phase still resets the job of its own send', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { isABTest: true });
		await start(t, seeded.campaignId);
		const job = await advanceWalk(t, seeded);

		await t.mutation(internal.campaigns.sendJob.createSendJob, {
			campaignId: seeded.campaignId,
			audience: job.audience,
			variantMode: 'ab_winner',
			testFraction: 0.2,
			splitPercentage: 20,
			winningVariant: 'B',
		});

		const state = await prepared(t, seeded);
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]).toMatchObject({
			variantMode: 'ab_winner',
			winningVariant: 'B',
			cursor: '',
			enqueuedCount: 0,
		});
	});

	it('setArchiveSnapshot keeps the archive link the prepared send is mailing', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		const stale = {
			archiveToken: 'stale-token',
			archiveHtmlContent: '<p>stale</p>',
			archiveSubject: 'Stale',
		};
		// Before this send is prepared, the previous release's own flow writes it.
		await t.mutation(internal.campaigns.archiveQueries.setArchiveSnapshot, {
			campaignId: seeded.campaignId,
			...stale,
		});
		expect((await prepared(t, seeded)).campaign?.archiveToken).toBe('stale-token');

		await start(t, seeded.campaignId);
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.campaignId, { archiveToken: 'committed-token' });
		});
		await t.mutation(internal.campaigns.archiveQueries.setArchiveSnapshot, {
			campaignId: seeded.campaignId,
			...stale,
		});

		expect((await prepared(t, seeded)).campaign?.archiveToken).toBe('committed-token');
	});
});
