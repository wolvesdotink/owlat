/**
 * The campaign send orchestrator's PREPARATION step (`startCampaignSend`):
 * everything between the fire-time guards and the hand-off to the send walker.
 *
 * These cases pin what one preparation leaves behind, outcome by outcome —
 * the campaign status and its audit trail, the content-scan row, the template
 * version captured for the send, the archive snapshot, the frozen segment and
 * the send job plus the walker hop it schedules — so the step can be reshaped
 * without changing what it writes.
 *
 * Scheduled work is held on fake timers and read back from
 * `_scheduled_functions`; nothing downstream of the preparation runs here.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
	createTestSegment,
	createTestTopic,
} from './factories';
import type { Doc, Id } from '../_generated/dataModel';

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

// The scanner verdict drives the outcome: >= 40 blocked, >= 15 suspicious,
// else clean. Default is clean.
vi.mock('@owlat/email-scanner', async (importOriginal) => {
	const original = await importOriginal<typeof import('@owlat/email-scanner')>();
	return {
		...original,
		scanContent: vi.fn(() => ({ score: 0, pass: true, flags: [], level: 'clean' as const })),
	};
});

const { scanContent: mockedScanContent } = await import('@owlat/email-scanner');

const BLOCKED_VERDICT = {
	score: 80,
	pass: false,
	flags: [{ type: 'prohibited_content', severity: 'high', description: 'Prohibited content' }],
	level: 'blocked',
};
const SUSPICIOUS_VERDICT = {
	score: 25,
	pass: false,
	flags: [{ type: 'spam_trigger', severity: 'medium', description: 'Spammy phrasing' }],
	level: 'suspicious',
};

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
	vi.unstubAllEnvs();
});

type Harness = TestConvex<typeof schema>;

interface SeedOptions {
	status?: 'scheduled' | 'sending';
	isABTest?: boolean;
	archiveEnabled?: boolean;
	segment?: boolean;
}

interface Seeded {
	campaignId: Id<'campaigns'>;
	templateId: Id<'emailTemplates'>;
}

/**
 * A campaign that passes pre-flight: verified domain, enabled sender,
 * published template, one eligible recipient. `scheduled` campaigns are due
 * a minute ago, as the scheduler tick finds them.
 */
async function seed(t: Harness, options: SeedOptions = {}): Promise<Seeded> {
	return await t.run(async (ctx) => {
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
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'r0@example.com', firstName: 'First0', doiStatus: 'not_required' })
		);
		let audience: Doc<'campaigns'>['audience'];
		if (options.segment) {
			const segmentId = await ctx.db.insert('segments', createTestSegment());
			audience = { kind: 'segment', segmentId };
		} else {
			const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
			audience = { kind: 'topic', topicId };
		}
		const status = options.status ?? 'sending';
		const campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status,
				...(status === 'sending' ? { sentAt: Date.now() } : {}),
				...(status === 'scheduled' ? { scheduledAt: Date.now() - 60_000 } : {}),
				emailTemplateId: templateId,
				fromEmail: 'sender@example.com',
				fromName: 'Test Sender',
				audience,
				subject: undefined,
				isABTest: options.isABTest ?? false,
				...(options.isABTest
					? {
							abTestConfig: {
								testType: 'subject' as const,
								splitPercentage: 20,
								variantBSubject: 'Variant B {{firstName}}',
								winnerCriteria: 'manual' as const,
							},
							abTestStatus: status === 'sending' ? ('testing' as const) : ('pending' as const),
						}
					: {}),
				...(options.archiveEnabled !== undefined ? { archiveEnabled: options.archiveEnabled } : {}),
			})
		);
		return { campaignId, templateId };
	});
}

interface Prepared {
	campaign: Doc<'campaigns'> | null;
	audits: Array<{ action: string; userId: string }>;
	scanRows: Doc<'contentScanResults'>[];
	versions: Doc<'emailTemplateVersions'>[];
	jobs: Doc<'campaignSendJobs'>[];
	scheduled: string[];
}

/** Everything a preparation can write, read back in one transaction. */
async function prepared(t: Harness, { campaignId, templateId }: Seeded): Promise<Prepared> {
	return await t.run(async (ctx) => {
		const audits = (await ctx.db.query('auditLogs').collect())
			.filter((row) => row.resourceId === String(campaignId))
			.map((row) => ({ action: row.action, userId: row.userId }));
		const scanRows = (await ctx.db.query('contentScanResults').collect()).filter(
			(row) => row.resourceId === String(campaignId)
		);
		const versions = await ctx.db
			.query('emailTemplateVersions')
			.withIndex('by_template_and_created_at', (q) => q.eq('templateId', templateId))
			.collect();
		const jobs = await ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
			.collect();
		const scheduled = (await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.state.kind === 'pending')
			.map((job) => job.name)
			.sort();
		return { campaign: await ctx.db.get(campaignId), audits, scanRows, versions, jobs, scheduled };
	});
}

async function start(t: Harness, campaignId: Id<'campaigns'>) {
	return await t.action(internal.campaigns.send.startCampaignSend, { campaignId });
}

describe('startCampaignSend preparation — a clean verdict', () => {
	it('a sending campaign: captures the version, opens a plain job, schedules the walker', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);

		const result = await start(t, seeded.campaignId);

		expect(result).toEqual({ totalRecipients: 0, totalBatches: 0 });
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('sending');
		expect(state.scanRows).toEqual([]);
		expect(state.versions.map((row) => row.trigger)).toEqual(['send']);
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]).toMatchObject({ phase: 'resolving', variantMode: 'plain', cursor: '' });
		expect(state.scheduled).toContain('campaigns/send:resolveCampaignPage');
		expect(state.audits).toEqual([]);
	});

	it('a scheduled campaign: moves to sending on the scheduler tick and opens the job', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });

		const result = await start(t, seeded.campaignId);

		expect(result.skipped ?? false).toBe(false);
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('sending');
		expect(state.campaign?.sentAt).toBeTypeOf('number');
		expect(state.campaign?.scheduledAt).toBeUndefined();
		expect(state.audits).toEqual([
			{ action: 'campaign.send_started', userId: 'system:scheduler_tick' },
		]);
		expect(state.versions.map((row) => row.trigger)).toEqual(['send']);
		expect(state.jobs).toHaveLength(1);
		expect(state.jobs[0]?.phase).toBe('resolving');
		expect(state.scheduled).toContain('campaigns/send:resolveCampaignPage');
	});

	it('freezes a segment audience on the campaign', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { segment: true });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		const audience = state.campaign?.audience;
		expect(audience?.kind).toBe('segment');
		expect(audience?.kind === 'segment' ? audience.frozenFilters : undefined).toBeDefined();
		expect(state.jobs[0]?.audience).toEqual(audience);
	});

	it('writes the public archive snapshot when the campaign archives and SITE_URL is set', async () => {
		vi.stubEnv('SITE_URL', 'https://owlat.example');
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { archiveEnabled: true });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.campaign?.archiveToken).toMatch(/^[\w-]{24}$/);
		expect(state.campaign?.archiveSubject).toBe('Hello {{firstName}}');
		expect(state.campaign?.archiveHtmlContent).toContain('Body for');
	});

	it('writes no archive snapshot when the campaign does not archive', async () => {
		vi.stubEnv('SITE_URL', 'https://owlat.example');
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { archiveEnabled: false });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.campaign?.archiveToken).toBeUndefined();
	});

	it('an A/B campaign already testing opens an ab_test job', async () => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { isABTest: true });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.jobs[0]).toMatchObject({ variantMode: 'ab_test', splitPercentage: 20 });
	});
});

describe('startCampaignSend preparation — a non-clean verdict', () => {
	it('blocked, from sending: draft with the reason, a scan row, and nothing prepared', async () => {
		(mockedScanContent as Mock).mockReturnValueOnce(BLOCKED_VERDICT);
		const t = convexTest(schema, modules);
		const seeded = await seed(t);

		const result = await start(t, seeded.campaignId);

		expect(result).toMatchObject({ skipped: true, reason: expect.stringMatching(/blocked/i) });
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('draft');
		expect(state.campaign?.contentBlockReason).toBe('Content blocked: Prohibited content');
		expect(state.scanRows.map((row) => [row.level, row.score])).toEqual([['blocked', 80]]);
		expect(state.audits).toEqual([
			{ action: 'campaign.content_blocked', userId: 'system:content_scan' },
		]);
		expect(state.versions).toEqual([]);
		expect(state.jobs).toEqual([]);
		expect(state.scheduled).not.toContain('campaigns/send:resolveCampaignPage');
	});

	it('blocked, from scheduled: the send starts and is reverted in the same audit trail', async () => {
		(mockedScanContent as Mock).mockReturnValueOnce(BLOCKED_VERDICT);
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });

		await start(t, seeded.campaignId);

		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('draft');
		expect(state.audits).toEqual([
			{ action: 'campaign.send_started', userId: 'system:scheduler_tick' },
			{ action: 'campaign.content_blocked', userId: 'system:content_scan' },
		]);
		expect(state.versions).toEqual([]);
		expect(state.jobs).toEqual([]);
		expect(state.scheduled).not.toContain('campaigns/send:resolveCampaignPage');
	});

	it('suspicious, from scheduled: held for review with a scan row and nothing prepared', async () => {
		(mockedScanContent as Mock).mockReturnValueOnce(SUSPICIOUS_VERDICT);
		const t = convexTest(schema, modules);
		const seeded = await seed(t, { status: 'scheduled' });

		const result = await start(t, seeded.campaignId);

		expect(result).toMatchObject({ skipped: true, reason: expect.stringMatching(/review/i) });
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe('pending_review');
		expect(state.scanRows.map((row) => row.level)).toEqual(['suspicious']);
		expect(state.audits).toEqual([
			{ action: 'campaign.send_started', userId: 'system:scheduler_tick' },
			{ action: 'campaign.flagged_for_review', userId: 'system:content_scan' },
		]);
		expect(state.versions).toEqual([]);
		expect(state.jobs).toEqual([]);
	});
});

describe('startCampaignSend preparation — fire-time guards write nothing', () => {
	it.each([
		['cancelled', /cancelled/i],
		['draft', /unscheduled/i],
		['sent', /already sent/i],
	] as const)('a %s campaign is skipped', async (status, reason) => {
		const t = convexTest(schema, modules);
		const seeded = await seed(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(seeded.campaignId, { status });
		});

		const result = await start(t, seeded.campaignId);

		expect(result).toMatchObject({ skipped: true, reason: expect.stringMatching(reason) });
		const state = await prepared(t, seeded);
		expect(state.campaign?.status).toBe(status);
		expect(state.versions).toEqual([]);
		expect(state.jobs).toEqual([]);
		expect(state.audits).toEqual([]);
	});
});
