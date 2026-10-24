/**
 * Integration tests for the campaign editor's autosave (`campaigns/drafts.ts`
 * saveDraft):
 *   - one call writes the whole draft, sections not chosen yet stay as stored
 *   - a partial draft (no audience, no email, empty name) saves without
 *     meeting send readiness
 *   - the per-section rules still hold (curated sender gate, live email)
 *     and a refused save writes nothing
 *   - only drafts are writable
 *   - the A/B test goes through its lifecycle only when it changed, so a
 *     repeated autosave leaves no audit entry behind
 *   - a save reports the `updatedAt` it found and the one it left, so the
 *     editor can tell whether anyone else wrote since its draft's base
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestCampaign,
	createTestCampaignSender,
	createTestEmailTemplate,
	createTestInstanceSettings,
	createTestTopic,
} from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = { userId: 'test-user', role: 'owner' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue(session),
		requireOrgPermission: vi.fn().mockResolvedValue(session),
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
			!path.includes('agent/steps/') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

async function seed(t: TestConvex<typeof schema>, campaign: Record<string, unknown> = {}) {
	return await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({ isCustomCampaignSendersAllowed: false })
		);
		await ctx.db.insert(
			'campaignSenders',
			createTestCampaignSender({ email: 'news@acme.com', isEnabled: true, isDefault: true })
		);
		const topicId = await ctx.db.insert('topics', createTestTopic());
		const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
		const campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				name: 'Stored',
				subject: 'Stored subject',
				fromEmail: 'news@acme.com',
				...campaign,
			})
		);
		return { topicId, templateId, campaignId };
	});
}

const read = (t: TestConvex<typeof schema>, id: Id<'campaigns'>) =>
	t.run(async (ctx) => await ctx.db.get(id));

const abAudits = (t: TestConvex<typeof schema>) =>
	t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect()).filter((row) => row.action.startsWith('ab_test.'))
	);

describe('campaigns.drafts.saveDraft', () => {
	it('writes every section of the draft in one call', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, topicId, templateId } = await seed(t);

		await t.mutation(api.campaigns.drafts.saveDraft, {
			campaignId,
			name: '  October update ',
			fromName: 'Acme',
			fromEmail: 'news@acme.com',
			replyTo: 'hello@acme.com',
			archiveEnabled: true,
			audience: { kind: 'topic', topicId },
			content: { emailTemplateId: templateId, subject: ' New things ' },
		});

		const row = await read(t, campaignId);
		expect(row).toMatchObject({
			name: 'October update',
			fromName: 'Acme',
			fromEmail: 'news@acme.com',
			replyTo: 'hello@acme.com',
			archiveEnabled: true,
			audience: { kind: 'topic', topicId },
			emailTemplateId: templateId,
			subject: 'New things',
		});
		expect(row?.searchableText).toContain('october update');
	});

	it('saves a partial draft and leaves unchosen sections as stored', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, topicId, templateId } = await seed(t, {});
		await t.run(async (ctx) =>
			ctx.db.patch(campaignId, {
				audience: { kind: 'topic', topicId },
				emailTemplateId: templateId,
			})
		);

		await t.mutation(api.campaigns.drafts.saveDraft, {
			campaignId,
			name: '',
			fromEmail: '',
		});

		const row = await read(t, campaignId);
		expect(row?.name).toBe('');
		expect(row?.fromEmail).toBe('');
		expect(row?.audience).toEqual({ kind: 'topic', topicId });
		expect(row?.emailTemplateId).toBe(templateId);
		expect(row?.subject).toBe('Stored subject');
	});

	it('refuses an off-list sender and writes nothing', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seed(t);

		await expect(
			t.mutation(api.campaigns.drafts.saveDraft, {
				campaignId,
				name: 'Changed',
				fromEmail: 'someone@else.example.com',
			})
		).rejects.toThrow(/approved campaign sender/);

		expect((await read(t, campaignId))?.name).toBe('Stored');
	});

	it('refuses an email in Recently deleted', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, templateId } = await seed(t);
		await t.run(async (ctx) => ctx.db.patch(templateId, { deletedAt: Date.now() }));

		await expect(
			t.mutation(api.campaigns.drafts.saveDraft, {
				campaignId,
				content: { emailTemplateId: templateId },
			})
		).rejects.toThrow();
	});

	it('reports the updatedAt it found and the one it left', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seed(t, { updatedAt: 1_000 });

		const saved = await t.mutation(api.campaigns.drafts.saveDraft, { campaignId, name: 'Changed' });
		expect(saved.previousUpdatedAt).toBe(1_000);
		expect(saved.updatedAt).toBe((await read(t, campaignId))?.updatedAt);
		expect(saved.updatedAt).toBeGreaterThan(1_000);

		const next = await t.mutation(api.campaigns.drafts.saveDraft, { campaignId, name: 'Again' });
		expect(next.previousUpdatedAt).toBe(saved.updatedAt);
	});

	it('only writes drafts', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seed(t, { status: 'scheduled', scheduledAt: Date.now() + 60_000 });

		await expect(
			t.mutation(api.campaigns.drafts.saveDraft, { campaignId, name: 'Changed' })
		).rejects.toThrow(/not in draft status/);
		expect((await read(t, campaignId))?.name).toBe('Stored');
	});

	it('runs the A/B lifecycle only when the test changed', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seed(t);
		const abTest = {
			enabled: true as const,
			testType: 'subject' as const,
			variantBSubject: 'Other subject',
			splitPercentage: 20,
			winnerCriteria: 'open_rate' as const,
			testDuration: 4,
		};

		await t.mutation(api.campaigns.drafts.saveDraft, { campaignId, abTest });
		await t.mutation(api.campaigns.drafts.saveDraft, { campaignId, abTest });
		expect((await abAudits(t)).map((row) => row.action)).toEqual(['ab_test.enabled']);
		expect((await read(t, campaignId))?.abTestConfig?.variantBSubject).toBe('Other subject');

		await t.mutation(api.campaigns.drafts.saveDraft, {
			campaignId,
			abTest: { ...abTest, variantBSubject: 'Third subject' },
		});
		const changed = await read(t, campaignId);
		expect(changed?.abTestStatus).toBe('pending');
		expect(changed?.abTestConfig?.variantBSubject).toBe('Third subject');

		await t.mutation(api.campaigns.drafts.saveDraft, { campaignId, abTest: { enabled: false } });
		await t.mutation(api.campaigns.drafts.saveDraft, { campaignId, abTest: { enabled: false } });
		const off = await read(t, campaignId);
		expect(off?.abTestStatus).toBeUndefined();
		expect((await abAudits(t)).map((row) => row.action)).toEqual([
			'ab_test.enabled',
			'ab_test.disabled',
			'ab_test.enabled',
			'ab_test.disabled',
		]);
	});

	it('refuses an incomplete A/B test with the same rule as enableABTest', async () => {
		const t = convexTest(schema, modules);
		const { campaignId } = await seed(t);

		await expect(
			t.mutation(api.campaigns.drafts.saveDraft, {
				campaignId,
				name: 'Changed',
				abTest: {
					enabled: true,
					testType: 'subject',
					splitPercentage: 20,
					winnerCriteria: 'manual',
				},
			})
		).rejects.toThrow(/Variant B subject is required/);
		expect((await read(t, campaignId))?.name).toBe('Stored');
	});
});
