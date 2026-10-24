/**
 * Fixtures for the campaign send preparation suites: a campaign that passes
 * pre-flight, and a read-back of everything one preparation can write.
 */

import type { TestConvex } from 'convex-test';
import type schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
	createTestSegment,
	createTestTopic,
} from '../factories';

export const BLOCKED_VERDICT = {
	score: 80,
	pass: false,
	flags: [{ type: 'prohibited_content', severity: 'high', description: 'Prohibited content' }],
	level: 'blocked',
};
export const SUSPICIOUS_VERDICT = {
	score: 25,
	pass: false,
	flags: [{ type: 'spam_trigger', severity: 'medium', description: 'Spammy phrasing' }],
	level: 'suspicious',
};

export type Harness = TestConvex<typeof schema>;

export interface SeedOptions {
	status?: 'scheduled' | 'sending';
	isABTest?: boolean;
	archiveEnabled?: boolean;
	segment?: boolean;
}

export interface Seeded {
	campaignId: Id<'campaigns'>;
	templateId: Id<'emailTemplates'>;
}

/**
 * A campaign that passes pre-flight: verified domain, enabled sender,
 * published template, one eligible recipient. `scheduled` campaigns are due
 * a minute ago, as the scheduler tick finds them.
 */
export async function seed(t: Harness, options: SeedOptions = {}): Promise<Seeded> {
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

export interface Prepared {
	campaign: Doc<'campaigns'> | null;
	audits: Array<{ action: string; userId: string }>;
	scanRows: Doc<'contentScanResults'>[];
	versions: Doc<'emailTemplateVersions'>[];
	jobs: Doc<'campaignSendJobs'>[];
	scheduled: string[];
}

/** Everything a preparation can write, read back in one transaction. */
export async function prepared(t: Harness, { campaignId, templateId }: Seeded): Promise<Prepared> {
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

export async function start(t: Harness, campaignId: Id<'campaigns'>) {
	return await t.action(internal.campaigns.send.startCampaignSend, { campaignId });
}
