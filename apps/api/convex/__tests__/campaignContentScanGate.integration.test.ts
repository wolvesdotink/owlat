/**
 * Integration tests for the Campaign send orchestrator's pre-send
 * content + URL-reputation scan gate.
 *
 * `startCampaignSend` renders the campaign body the same way the real send
 * does (default-language template content + campaign subject override) and
 * runs it through `scanContent` (+ Google Safe Browsing URL reputation when a
 * key is configured). The combined score drives the lifecycle:
 *   - blocked    (score >= 40) → revert to `draft` with a contentBlockReason
 *                                (audit `campaign.content_blocked`); no send.
 *   - suspicious (score >= 15) → `pending_review` for admin review
 *                                (audit `campaign.flagged_for_review`); no send.
 *   - clean                    → proceed to the checkpointed send walker.
 *
 * The scanner verdict is mocked at its module boundary so each case is
 * deterministic. URL reputation is a no-op here (no GOOGLE_SAFE_BROWSING_API_KEY
 * in the test env), so the combined score is exactly the mocked content score.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, type Mock } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailTemplate,
	createTestTopic,
	createTestDomain,
} from './factories';
import type { Id } from '../_generated/dataModel';

// Pre-flight loads the domain verification status through an authed query;
// stub the session helpers so the internal orchestrator action can run it.
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

// Mock @owlat/email-scanner so the content verdict is deterministic. The
// orchestrator recomputes the level from the score via the real
// `levelForScore`, so each test drives the outcome by returning a score:
// >= 40 blocked, >= 15 suspicious, else clean. Default is clean.
vi.mock('@owlat/email-scanner', async (importOriginal) => {
	const original = await importOriginal<typeof import('@owlat/email-scanner')>();
	return {
		...original,
		scanContent: vi.fn(() => ({
			score: 0,
			pass: true,
			flags: [],
			level: 'clean' as const,
		})),
	};
});

const { scanContent: mockedScanContent } = await import('@owlat/email-scanner');

const allModules = import.meta.glob('../**/*.*s');
// Exclude the `'use node'` provider/workpool deps convex-test can't bootstrap;
// keep everything the orchestrator itself needs.
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool'),
	),
);

interface Setup {
	campaignId: Id<'campaigns'>;
	topicId: Id<'topics'>;
}

// A NON-A/B campaign already in `sending` with a verified domain, a published
// template, and one eligible topic member — the minimal shape that passes
// pre-flight and reaches the scan gate.
async function setupSendableCampaign(t: TestConvex<typeof schema>): Promise<Setup> {
	return await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({ domain: 'example.com', status: 'verified', lastVerifiedAt: Date.now() }),
		);
		const template = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'published',
				subject: 'Hello {{firstName}}',
				htmlContent: '<p>Body for {{firstName}}</p>',
				defaultLanguage: 'en',
			}),
		);
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		const cid = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'r0@example.com', firstName: 'First0', doiStatus: 'not_required' }),
		);
		await ctx.db.insert('contactTopics', { contactId: cid, topicId, addedAt: Date.now() });

		const campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'sending',
				sentAt: Date.now(),
				emailTemplateId: template,
				fromEmail: 'sender@example.com',
				fromName: 'Test Sender',
				audience: { kind: 'topic', topicId },
				subject: undefined,
				isABTest: false,
			}),
		);
		return { campaignId, topicId };
	});
}

async function countSends(t: TestConvex<typeof schema>, campaignId: Id<'campaigns'>) {
	return await t.run(async (ctx) =>
		(
			await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
				.collect()
		).length,
	);
}

async function latestAudit(t: TestConvex<typeof schema>, campaignId: Id<'campaigns'>) {
	return await t.run(async (ctx) => {
		const logs = await ctx.db
			.query('auditLogs')
			.collect()
			.then((all) => all.filter((l) => l.resourceId === String(campaignId)));
		return logs.at(-1);
	});
}

async function scanRow(t: TestConvex<typeof schema>, campaignId: Id<'campaigns'>) {
	return await t.run(async (ctx) => {
		const rows = await ctx.db.query('contentScanResults').collect();
		return rows.find((r) => r.resourceId === String(campaignId));
	});
}

describe('Campaign send orchestrator — pre-send content scan gate', () => {
	it('a blocked verdict reverts the campaign to draft and sends nothing', async () => {
		(mockedScanContent as Mock).mockReturnValueOnce({
			score: 80,
			pass: false,
			flags: [{ type: 'prohibited_content', severity: 'high', description: 'Prohibited content' }],
			level: 'blocked',
		});

		const t = convexTest(schema, modules);
		const { campaignId } = await setupSendableCampaign(t);

		const result = await t.action(internal.campaigns.send.startCampaignSend, { campaignId });

		expect(result.skipped).toBe(true);
		expect(result.reason).toMatch(/blocked/i);
		expect(await countSends(t, campaignId)).toBe(0);

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.status).toBe('draft');
		expect(campaign?.contentBlockReason).toMatch(/Content blocked/i);

		const scan = await scanRow(t, campaignId);
		expect(scan?.level).toBe('blocked');
		expect(scan?.score).toBe(80);

		expect((await latestAudit(t, campaignId))?.action).toBe('campaign.content_blocked');
	});

	it('a suspicious verdict flags the campaign for review and sends nothing', async () => {
		(mockedScanContent as Mock).mockReturnValueOnce({
			score: 25,
			pass: false,
			flags: [{ type: 'spam_keywords', severity: 'medium', description: 'Spam keywords' }],
			level: 'suspicious',
		});

		const t = convexTest(schema, modules);
		const { campaignId } = await setupSendableCampaign(t);

		const result = await t.action(internal.campaigns.send.startCampaignSend, { campaignId });

		expect(result.skipped).toBe(true);
		expect(result.reason).toMatch(/review/i);
		expect(await countSends(t, campaignId)).toBe(0);

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.status).toBe('pending_review');

		const scan = await scanRow(t, campaignId);
		expect(scan?.level).toBe('suspicious');
		expect(scan?.score).toBe(25);

		expect((await latestAudit(t, campaignId))?.action).toBe('campaign.flagged_for_review');
	});

	it('a clean verdict is NOT gated — the send walker starts and status stays sending', async () => {
		// Default mock returns clean (score 0).
		const t = convexTest(schema, modules);
		const { campaignId } = await setupSendableCampaign(t);

		await t.action(internal.campaigns.send.startCampaignSend, { campaignId });

		const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(campaign?.status).toBe('sending');

		// A clean scan writes no contentScanResults row and opens the send job.
		// (`t.run` serializes the helper's `undefined` miss to `null`.)
		expect(await scanRow(t, campaignId)).toBeNull();
		const job = await t.run(async (ctx) =>
			ctx.db
				.query('campaignSendJobs')
				.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
				.first(),
		);
		expect(job?.phase).toBe('resolving');
	});
});
