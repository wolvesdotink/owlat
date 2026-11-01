/**
 * Recently deleted for campaigns, automations and email templates
 * (`lib/softDelete.ts`, the three `deletion.ts` owners and the purge in
 * `marketing/recentlyDeleted.ts`).
 *
 * For each kind: a delete keeps the row and what hangs off it but takes it out
 * of every ordinary read (get, list, filtered list, search, counts); restore
 * brings back the same id with the same content; a stale tab cannot write to a
 * deleted row; the permission a delete needs is the one a restore needs; the
 * purge removes a row only once its 30 days are up, in bounded batches that
 * resume a row whose children outrun one transaction, and a restore that comes
 * first wins while one that comes after the purge started is refused.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as SessionOrganization from '../lib/sessionOrganization';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestCampaign,
	createTestEmailTemplate,
	enableFeatures,
} from './factories';
import { SOFT_DELETE_RETENTION_MS } from '../lib/softDelete';
import { PURGE_BATCH } from '../marketing/recentlyDeleted';
import { ErasureBudget } from '../contacts/erasure/budget';
import { purgeExpiredAutomations } from '../automations/deletion';

const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-alice', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const { realPermissionGate } = await import('./helpers/permissionGateMock');
	const gate = realPermissionGate(actual, () => sessionMock.user.role);
	const session = async () => ({
		userId: sessionMock.user.id,
		role: sessionMock.user.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.user.id),
		getMutationContext: vi.fn().mockImplementation(session),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(session),
		requireOrgPermission: vi
			.fn()
			.mockImplementation(async (_ctx: unknown, permission: string, message?: string) => {
				gate(permission, message);
				return session();
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

type T = TestConvex<typeof schema>;
const PAGE = { numItems: 50, cursor: null };
const HOUR = 60 * 60 * 1000;

const setUser = (id: string, role: 'owner' | 'admin' | 'editor') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

beforeEach(() => setUser('user-alice', 'owner'));

async function freshT(): Promise<T> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['campaigns', 'automations']);
	return t;
}

const seedCampaign = (t: T, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) => ctx.db.insert('campaigns', createTestCampaign(overrides) as never));

const seedTemplate = (t: T, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) =>
		ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'draft',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				...overrides,
			}) as never
		)
	);

const seedAutomation = (t: T, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) => ctx.db.insert('automations', createTestAutomation(overrides) as never));

const auditActions = (t: T, resourceId: string) =>
	t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect())
			.filter((row) => row.resourceId === resourceId)
			.map((row) => row.action)
	);

const purgeAt = (t: T, now: number) =>
	t.mutation(internal.marketing.recentlyDeleted.purgeExpired, { now });

describe('campaigns', () => {
	it('delete keeps the row, hides it from every read, and restore brings it back unchanged', async () => {
		const t = await freshT();
		const keep = await t.mutation(api.campaigns.campaigns.create, { name: 'Spring launch' });
		const campaignId = await t.mutation(api.campaigns.campaigns.create, { name: 'Autumn sale' });
		const before = await t.run(async (ctx) => ctx.db.get(campaignId));

		await t.mutation(api.campaigns.campaigns.remove, { campaignId });

		expect(await t.query(api.campaigns.campaigns.getWithRelations, { campaignId })).toBeNull();
		const listed = await t.query(api.campaigns.campaigns.list, { paginationOpts: PAGE });
		expect(listed.page.map((c) => c._id)).toEqual([keep]);
		const drafts = await t.query(api.campaigns.campaigns.list, {
			status: 'draft',
			paginationOpts: PAGE,
		});
		expect(drafts.page.map((c) => c._id)).toEqual([keep]);
		const searched = await t.query(api.campaigns.campaigns.list, {
			search: 'autumn',
			paginationOpts: PAGE,
		});
		expect(searched.page).toEqual([]);
		const counts = await t.query(api.campaigns.organization.countByStatusByOrganization, {});
		expect(counts['draft']).toBe(1);
		expect(counts['total']).toBe(1);

		const trash = await t.query(api.campaigns.deletion.listDeleted, { paginationOpts: PAGE });
		expect(trash.page).toEqual([
			expect.objectContaining({ _id: campaignId, name: 'Autumn sale', status: 'draft' }),
		]);
		expect(trash.page[0]!.purgeAt - trash.page[0]!.deletedAt).toBe(SOFT_DELETE_RETENTION_MS);

		await t.mutation(api.campaigns.campaigns.restore, { campaignId });

		const after = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(after).toEqual(before);
		const relisted = await t.query(api.campaigns.campaigns.list, { paginationOpts: PAGE });
		expect(relisted.page.map((c) => c._id).sort()).toEqual([campaignId, keep].sort());
		const recounted = await t.query(api.campaigns.organization.countByStatusByOrganization, {});
		expect(recounted['draft']).toBe(2);
		expect(await auditActions(t, campaignId)).toEqual(
			expect.arrayContaining(['campaign.deleted', 'campaign.restored'])
		);
	});

	it('a repeated delete keeps the first stamp and moves no counter twice', async () => {
		const t = await freshT();
		const campaignId = await t.mutation(api.campaigns.campaigns.create, { name: 'Twice' });
		await t.mutation(api.campaigns.campaigns.remove, { campaignId });
		const first = await t.run(async (ctx) => ctx.db.get(campaignId));

		await t.mutation(api.campaigns.campaigns.remove, { campaignId });
		const second = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(second?.deletedAt).toBe(first?.deletedAt);

		await t.mutation(api.campaigns.campaigns.restore, { campaignId });
		await t.mutation(api.campaigns.campaigns.restore, { campaignId });
		const counts = await t.query(api.campaigns.organization.countByStatusByOrganization, {});
		expect(counts['draft']).toBe(1);
		const actions = await auditActions(t, campaignId);
		expect(actions.filter((a) => a === 'campaign.deleted')).toHaveLength(1);
		expect(actions.filter((a) => a === 'campaign.restored')).toHaveLength(1);
	});

	it('filtered pages stay full when deleted rows sit between live ones', async () => {
		const t = await freshT();
		const live: Id<'campaigns'>[] = [];
		for (let i = 0; i < 9; i++) {
			const id = await seedCampaign(t, { status: 'sent', updatedAt: 1_000 + i });
			if (i % 3 === 0) {
				await t.mutation(api.campaigns.campaigns.remove, { campaignId: id });
			} else {
				live.push(id);
			}
		}
		const page = await t.query(api.campaigns.campaigns.list, {
			status: 'sent',
			paginationOpts: { numItems: 3, cursor: null },
		});
		expect(page.page).toHaveLength(3);
		expect(page.page.every((c) => live.includes(c._id))).toBe(true);
	});

	it('unschedules a scheduled campaign on the way in, so nothing can send it', async () => {
		const t = await freshT();
		const campaignId = await seedCampaign(t, {
			status: 'scheduled',
			scheduledAt: Date.now() + 2 * HOUR,
		});

		await t.mutation(api.campaigns.campaigns.remove, { campaignId });

		const row = await t.run(async (ctx) => ctx.db.get(campaignId));
		expect(row?.status).toBe('draft');
		expect(row?.scheduledAt).toBeUndefined();
		expect(await auditActions(t, campaignId)).toEqual(
			expect.arrayContaining(['campaign.unscheduled', 'campaign.deleted'])
		);
		// The lifecycle refuses every transition of a deleted campaign.
		const outcome = await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId,
			input: { to: 'sending', at: Date.now() },
			userId: 'system:test',
		});
		expect(outcome).toEqual({ ok: false, reason: 'campaign_not_found' });
		const due = await t.query(internal.campaigns.sendQueries.getDueScheduledCampaigns, {});
		expect(due).toEqual([]);
		const preflight = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});
		expect(preflight).toEqual(expect.objectContaining({ ok: false, reason: 'not_found' }));
	});

	it('still refuses to delete a campaign that is sending', async () => {
		const t = await freshT();
		const campaignId = await seedCampaign(t, { status: 'sending' });
		await expect(t.mutation(api.campaigns.campaigns.remove, { campaignId })).rejects.toThrow(
			/currently sending/
		);
		expect((await t.run(async (ctx) => ctx.db.get(campaignId)))?.deletedAt).toBeUndefined();
	});

	it('a stale tab cannot edit, duplicate or schedule a deleted campaign', async () => {
		const t = await freshT();
		const campaignId = await seedCampaign(t, { status: 'draft' });
		await t.mutation(api.campaigns.campaigns.remove, { campaignId });

		await expect(
			t.mutation(api.campaigns.campaigns.updateBasics, { campaignId, name: 'Edited' })
		).rejects.toThrow(/not found/i);
		await expect(t.mutation(api.campaigns.campaigns.duplicate, { campaignId })).rejects.toThrow(
			/not found/i
		);
		await expect(
			t.mutation(api.campaigns.scheduling.schedule, {
				campaignId,
				scheduledAt: Date.now() + HOUR,
			})
		).rejects.toThrow(/not found/i);
	});

	it('hides a deleted campaign from search, attention and its public archive', async () => {
		const t = await freshT();
		const campaignId = await seedCampaign(t, {
			name: 'Archived newsletter',
			searchableText: 'archived newsletter',
			status: 'cancelled',
			updatedAt: Date.now(),
			archiveToken: 'tok-archived',
			archiveEnabled: true,
			archiveHtmlContent: '<p>hi</p>',
		});
		await t.mutation(api.campaigns.campaigns.remove, { campaignId });

		const candidates = await t.query(api.campaigns.organization.listAttentionCandidates, {});
		expect(candidates.map((c) => c._id)).not.toContain(campaignId);
		const search = await t.query(api.search.global.search, { query: 'archived' });
		expect(search.campaigns).toEqual([]);
		await t.run(async (ctx) => ctx.db.patch(campaignId, { status: 'sent' }));
		expect(
			await t.query(internal.campaigns.archiveQueries.getCampaignByArchiveToken, {
				archiveToken: 'tok-archived',
			})
		).toBeNull();
	});

	it('an editor holds campaigns:manage, so may delete and restore any campaign', async () => {
		const t = await freshT();
		const campaignId = await seedCampaign(t);
		setUser('user-bob', 'owner');
		await t.mutation(api.campaigns.campaigns.remove, { campaignId });
		setUser('user-eve', 'editor');
		await t.mutation(api.campaigns.campaigns.restore, { campaignId });
		expect((await t.run(async (ctx) => ctx.db.get(campaignId)))?.deletedAt).toBeUndefined();
	});
});

describe('automations', () => {
	it('keeps the steps, hides the automation, and restores the same workflow', async () => {
		const t = await freshT();
		const automationId = await seedAutomation(t, { status: 'paused' });
		const stepId = await t.run(async (ctx) =>
			ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepType: 'delay', stepIndex: 0 }) as never
			)
		);

		await t.mutation(api.automations.automations.remove, { automationId });

		expect(await t.query(api.automations.automations.get, { automationId })).toBeNull();
		expect(
			(await t.query(api.automations.automations.list, { paginationOpts: PAGE })).page
		).toEqual([]);
		expect(
			(
				await t.query(api.automations.automations.list, {
					status: 'paused',
					paginationOpts: PAGE,
				})
			).page
		).toEqual([]);
		expect((await t.query(api.automations.automations.countByStatus, {}))['paused']).toBe(0);
		expect(await t.run(async (ctx) => ctx.db.get(stepId))).not.toBeNull();

		// Nothing can switch a deleted automation back on.
		await expect(
			t.mutation(api.automations.automations.resume, { automationId })
		).rejects.toThrow();
		await expect(
			t.mutation(api.automations.automations.update, { automationId, name: 'x' })
		).rejects.toThrow(/not found/i);

		await t.mutation(api.automations.automations.restore, { automationId });
		const restored = await t.query(api.automations.automations.get, { automationId });
		expect(restored?.status).toBe('paused');
		expect(restored?.steps.map((s) => s._id)).toEqual([stepId]);
		expect((await t.query(api.automations.automations.countByStatus, {}))['paused']).toBe(1);
	});

	it('refuses to delete an active automation', async () => {
		const t = await freshT();
		const automationId = await seedAutomation(t, { status: 'active' });
		await expect(t.mutation(api.automations.automations.remove, { automationId })).rejects.toThrow(
			/pause first/
		);
	});

	it('restore needs automations:manage, like delete', async () => {
		const t = await freshT();
		const automationId = await seedAutomation(t);
		await t.mutation(api.automations.automations.remove, { automationId });
		setUser('user-eve', 'editor');
		await expect(
			t.mutation(api.automations.automations.restore, { automationId })
		).rejects.toThrow();
		await expect(
			t.query(api.automations.deletion.listDeleted, { paginationOpts: PAGE })
		).rejects.toThrow();
		setUser('user-ada', 'admin');
		await t.mutation(api.automations.automations.restore, { automationId });
	});

	it('restore is behind the automations flag', async () => {
		const t = await freshT();
		const automationId = await seedAutomation(t);
		await t.mutation(api.automations.automations.remove, { automationId });
		await t.run(async (ctx) => {
			const flagRow = await ctx.db.query('featureFlagSettings').first();
			if (flagRow) {
				await ctx.db.patch(flagRow._id, {
					featureFlags: { ...flagRow.featureFlags, automations: false },
				});
			}
			const settings = await ctx.db.query('instanceSettings').first();
			if (settings) {
				await ctx.db.patch(settings._id, {
					featureFlags: { ...settings.featureFlags, automations: false },
				});
			}
		});
		await expect(t.mutation(api.automations.automations.restore, { automationId })).rejects.toThrow(
			/automations\\?" is disabled/
		);
	});
});

describe('email templates', () => {
	it('keeps history and block usage in step with delete and restore', async () => {
		const t = await freshT();
		const blockId = await t.run(async (ctx) =>
			ctx.db.insert('emailBlocks', {
				name: 'Footer',
				content: '[]',
				usageCount: 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			} as never)
		);
		const templateId = await seedTemplate(t, {
			name: 'Autumn header',
			searchableText: 'autumn header',
			linkedBlockIds: [blockId],
		});
		await t.mutation(api.emailTemplates.emails.update, { templateId, name: 'Autumn header' });

		await t.mutation(api.emailTemplates.emails.remove, { templateId });

		expect(await t.query(api.emailTemplates.emails.get, { templateId })).toBeNull();
		expect(
			(await t.query(api.emailTemplates.emails.list, { type: 'marketing', paginationOpts: PAGE }))
				.page
		).toEqual([]);
		expect(
			(await t.query(api.emailTemplates.emails.list, { search: 'autumn', paginationOpts: PAGE }))
				.page
		).toEqual([]);
		const counts = await t.query(api.emailTemplates.organization.countByTypeByOrganization, {});
		expect(counts['marketing']).toBe(0);
		expect((await t.run(async (ctx) => ctx.db.get(blockId)))?.usageCount).toBe(0);
		// The history is kept for a restore, but nobody can read it meanwhile.
		const kept = await t.run(async (ctx) =>
			ctx.db
				.query('emailTemplateVersions')
				.withIndex('by_template_and_created_at', (q) => q.eq('templateId', templateId))
				.collect()
		);
		expect(kept.length).toBeGreaterThan(0);
		setUser('user-eve', 'editor');
		expect(await t.query(api.emailTemplates.versions.list, { templateId })).toEqual([]);
		await expect(
			t.query(api.emailTemplates.versions.get, { versionId: kept[0]!._id })
		).rejects.toThrow(/not found/i);
		setUser('user-alice', 'owner');
		await expect(
			t.mutation(api.emailTemplates.emails.update, { templateId, name: 'Stale tab' })
		).rejects.toThrow(/not found/i);
		await expect(t.mutation(api.emailTemplates.emails.publish, { templateId })).rejects.toThrow(
			/not found/i
		);
		// Nothing sends it while it is deleted.
		expect(
			await t.query(internal.automations.stepExecutorQueries.getEmailTemplateForStep, {
				templateId,
			})
		).toBeNull();
		expect(
			await t.query(internal.campaigns.sendQueries.getEmailTemplate, { templateId })
		).toBeNull();

		await t.mutation(api.emailTemplates.emails.restore, { templateId });

		expect((await t.query(api.emailTemplates.emails.get, { templateId }))?.name).toBe(
			'Autumn header'
		);
		expect((await t.run(async (ctx) => ctx.db.get(blockId)))?.usageCount).toBe(1);
		expect(await t.query(api.emailTemplates.versions.list, { templateId })).toHaveLength(
			kept.length
		);
		const recounted = await t.query(api.emailTemplates.organization.countByTypeByOrganization, {});
		expect(recounted['marketing']).toBe(1);
	});

	it('a campaign whose template was deleted fails pre-flight until it is restored', async () => {
		const t = await freshT();
		const templateId = await seedTemplate(t);
		const campaignId = await seedCampaign(t, { emailTemplateId: templateId });
		await t.mutation(api.emailTemplates.emails.remove, { templateId });

		const preflight = await t.query(internal.campaigns.preflight.validateReadyToSendQuery, {
			campaignId,
		});
		expect(preflight).toEqual(expect.objectContaining({ ok: false, reason: 'no_template' }));
		const relations = await t.query(api.campaigns.campaigns.getWithRelations, { campaignId });
		expect(relations?.emailTemplate).toBeNull();
	});

	it('restore needs templates:manage, like delete', async () => {
		const t = await freshT();
		const templateId = await seedTemplate(t);
		await t.mutation(api.emailTemplates.emails.remove, { templateId });
		setUser('user-eve', 'editor');
		await expect(t.mutation(api.emailTemplates.emails.restore, { templateId })).rejects.toThrow();
		await expect(
			t.query(api.emailTemplates.deletion.listDeleted, { paginationOpts: PAGE })
		).rejects.toThrow();
	});
});

describe('the 30-day purge', () => {
	it('keeps a deleted item until its 30 days are up, then removes it with its children', async () => {
		const t = await freshT();
		const campaignId = await seedCampaign(t);
		const automationId = await seedAutomation(t);
		const stepId = await t.run(async (ctx) =>
			ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepType: 'delay', stepIndex: 0 }) as never
			)
		);
		const templateId = await seedTemplate(t);
		await t.mutation(api.campaigns.campaigns.remove, { campaignId });
		await t.mutation(api.automations.automations.remove, { automationId });
		await t.mutation(api.emailTemplates.emails.remove, { templateId });
		const stamps = await t.run(async (ctx) => [
			(await ctx.db.get(campaignId))!.deletedAt!,
			(await ctx.db.get(automationId))!.deletedAt!,
			(await ctx.db.get(templateId))!.deletedAt!,
		]);

		const early = await purgeAt(t, Math.min(...stamps) + SOFT_DELETE_RETENTION_MS - 1);
		expect(early).toEqual({ campaigns: 0, automations: 0, templates: 0, hasMore: false });

		const due = await purgeAt(t, Math.max(...stamps) + SOFT_DELETE_RETENTION_MS + 1);
		expect(due).toEqual({ campaigns: 1, automations: 1, templates: 1, hasMore: false });
		await t.run(async (ctx) => {
			expect(await ctx.db.get(campaignId)).toBeNull();
			expect(await ctx.db.get(automationId)).toBeNull();
			expect(await ctx.db.get(stepId)).toBeNull();
			expect(await ctx.db.get(templateId)).toBeNull();
		});
		expect(await auditActions(t, campaignId)).toContain('campaign.purged');

		// Too late to restore: the row is gone.
		await expect(t.mutation(api.campaigns.campaigns.restore, { campaignId })).rejects.toThrow(
			/not found/i
		);
	});

	it('a restore that comes first takes the item out of the purge', async () => {
		const t = await freshT();
		const campaignId = await seedCampaign(t);
		await t.mutation(api.campaigns.campaigns.remove, { campaignId });
		const { deletedAt } = (await t.run(async (ctx) => ctx.db.get(campaignId)))!;
		await t.mutation(api.campaigns.campaigns.restore, { campaignId });

		await purgeAt(t, deletedAt! + SOFT_DELETE_RETENTION_MS + 1);
		expect(await t.run(async (ctx) => ctx.db.get(campaignId))).not.toBeNull();
	});

	it('works through a backlog in bounded batches and schedules the rest', async () => {
		const t = await freshT();
		const deletedAt = 1_000;
		await t.run(async (ctx) => {
			for (let i = 0; i < PURGE_BATCH + 3; i++) {
				await ctx.db.insert(
					'campaigns',
					createTestCampaign({ deletedAt: deletedAt + i, deletedBy: 'user-alice' }) as never
				);
			}
		});
		const now = deletedAt + SOFT_DELETE_RETENTION_MS + PURGE_BATCH + 10;

		const first = await purgeAt(t, now);
		expect(first).toEqual(expect.objectContaining({ campaigns: PURGE_BATCH, hasMore: true }));
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled.some((job) => job.name.includes('recentlyDeleted'))).toBe(true);

		const second = await purgeAt(t, now);
		expect(second).toEqual(expect.objectContaining({ campaigns: 3, hasMore: false }));
		expect(await t.run(async (ctx) => ctx.db.query('campaigns').collect())).toEqual([]);
	});
});

describe('the purge resumes what outruns one transaction', () => {
	const MIB = 1024 * 1024;
	const expired = (now: number) => now + SOFT_DELETE_RETENTION_MS + 1;

	it('a partly purged automation can no longer be restored, and the next pass finishes it', async () => {
		const t = await freshT();
		const automationId = await seedAutomation(t, { deletedAt: 1_000, deletedBy: 'user-alice' });
		await t.run(async (ctx) => {
			for (let i = 0; i < 12; i++) {
				await ctx.db.insert(
					'automationSteps',
					createTestAutomationStep({ automationId, stepType: 'delay', stepIndex: i }) as never
				);
			}
		});

		// A budget of five rows stops the purge partway through the steps.
		const partial = await t.run(async (ctx) =>
			purgeExpiredAutomations(ctx, expired(1_000), PURGE_BATCH, new ErasureBudget(5, 4 * MIB))
		);
		expect(partial).toEqual({ purged: 0, hasMore: true });
		const left = await t.run(async (ctx) => ({
			row: await ctx.db.get(automationId),
			steps: await ctx.db
				.query('automationSteps')
				.withIndex('by_automation', (q) => q.eq('automationId', automationId))
				.collect(),
		}));
		expect(left.row?.purgeStartedAt).toBeDefined();
		expect(left.steps).toHaveLength(7);

		await expect(t.mutation(api.automations.automations.restore, { automationId })).rejects.toThrow(
			/can no longer be restored/
		);
		expect(
			(await t.query(api.automations.deletion.listDeleted, { paginationOpts: PAGE })).page
		).toEqual([]);

		expect(await purgeAt(t, expired(1_000))).toEqual(
			expect.objectContaining({ automations: 1, hasMore: false })
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(automationId)).toBeNull();
			expect(await ctx.db.query('automationSteps').collect()).toEqual([]);
		});
	});

	it('large version histories drain over several passes within the byte budget', async () => {
		const t = await freshT();
		const body = 'x'.repeat(900 * 1024);
		const templateIds: Id<'emailTemplates'>[] = [];
		for (const deletedAt of [1_000, 1_001]) {
			const templateId = await seedTemplate(t, { deletedAt, deletedBy: 'user-alice' });
			templateIds.push(templateId);
			await t.run(async (ctx) => {
				for (let i = 0; i < 6; i++) {
					await ctx.db.insert('emailTemplateVersions', {
						templateId,
						trigger: 'save',
						content: body,
						name: 'Snapshot',
						subject: 'Snapshot',
						contentBytes: body.length,
						contentHash: `hash-${i}`,
						createdBy: 'user-alice',
						createdAt: i,
					});
				}
			});
		}
		const versionsLeft = () =>
			t.run(async (ctx) => (await ctx.db.query('emailTemplateVersions').collect()).length);

		// About 10.5 MiB of history against a 4 MiB allowance: each pass removes
		// part of it, the first template is marked, and nothing is restorable.
		const first = await purgeAt(t, expired(1_001));
		expect(first).toEqual(expect.objectContaining({ templates: 0, hasMore: true }));
		const afterFirst = await versionsLeft();
		expect(afterFirst).toBeGreaterThan(0);
		expect(afterFirst).toBeLessThan(12);
		expect(12 - afterFirst).toBeLessThanOrEqual(4);
		expect((await t.run(async (ctx) => ctx.db.get(templateIds[0]!)))?.purgeStartedAt).toBeDefined();
		await expect(
			t.mutation(api.emailTemplates.emails.restore, { templateId: templateIds[0]! })
		).rejects.toThrow(/can no longer be restored/);

		let passes = 1;
		let purged = 0;
		for (let more = true; more && passes < 10; passes++) {
			const pass = await purgeAt(t, expired(1_001));
			purged += pass.templates;
			more = pass.hasMore;
		}
		expect(purged).toBe(2);
		expect(passes).toBeGreaterThan(2);
		expect(await versionsLeft()).toBe(0);
		await t.run(async (ctx) => {
			for (const templateId of templateIds) expect(await ctx.db.get(templateId)).toBeNull();
		});
	});
});

describe('saved blocks and deleted templates', () => {
	const linkedContent = (blockId: Id<'emailBlocks'>, text: string) =>
		JSON.stringify({
			blocks: [
				{
					id: 'block1',
					type: 'text',
					content: { text },
					savedBlockRef: { blockId, groupId: 'g1', blockName: 'Footer' },
				},
			],
		});
	const seedBlock = (t: T, name = 'Footer') =>
		t.run(async (ctx) =>
			ctx.db.insert('emailBlocks', {
				name,
				content: '[]',
				usageCount: 1,
				createdAt: 1,
				updatedAt: 1,
			})
		);
	const firstBlock = async (t: T, templateId: Id<'emailTemplates'>) => {
		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		const parsed = JSON.parse(row!.content);
		return { row: row!, block: (parsed.blocks ?? parsed)[0] };
	};

	it('a block edit passes a deleted template by, which comes back as it was deleted', async () => {
		const t = await freshT();
		const blockId = await seedBlock(t);
		const templateId = await seedTemplate(t, {
			content: linkedContent(blockId, 'original'),
			linkedBlockIds: [blockId],
		});
		await t.mutation(api.emailTemplates.emails.remove, { templateId });
		const before = await t.run(async (ctx) => ctx.db.get(templateId));

		await t.mutation(internal.emailBlocks.module.update, {
			blockId,
			patch: {
				content: JSON.stringify({
					blocks: [{ id: 'new', type: 'text', content: { text: 'replacement' } }],
				}),
			},
			userId: 'user-alice',
		});
		expect((await t.run(async (ctx) => ctx.db.get(templateId)))?.content).toBe(before!.content);

		await t.mutation(api.emailTemplates.emails.restore, { templateId });
		const { row, block } = await firstBlock(t, templateId);
		expect(block.content.text).toBe('original');
		expect(block.savedBlockRef.blockId).toBe(blockId);
		expect(row.linkedBlockIds).toEqual([blockId]);
		expect((await t.run(async (ctx) => ctx.db.get(blockId)))?.usageCount).toBe(1);
	});

	it('restore detaches blocks deleted meanwhile and takes up renames', async () => {
		const t = await freshT();
		const goneId = await seedBlock(t, 'Gone');
		const renamedId = await seedBlock(t, 'Footer');
		const content = JSON.stringify({
			blocks: [
				{
					id: 'a',
					type: 'text',
					content: { text: 'kept text' },
					savedBlockRef: { blockId: goneId, groupId: 'g1', blockName: 'Gone' },
				},
				{
					id: 'b',
					type: 'text',
					content: { text: 'footer' },
					savedBlockRef: { blockId: renamedId, groupId: 'g2', blockName: 'Footer' },
				},
			],
		});
		const templateId = await seedTemplate(t, { content, linkedBlockIds: [goneId, renamedId] });
		await t.mutation(api.emailTemplates.emails.remove, { templateId });

		await t.mutation(internal.emailBlocks.module.remove, { blockId: goneId, userId: 'user-alice' });
		await t.mutation(internal.emailBlocks.module.update, {
			blockId: renamedId,
			patch: { name: 'Footer v2' },
			userId: 'user-alice',
		});
		// Neither reached the deleted template.
		expect((await t.run(async (ctx) => ctx.db.get(templateId)))?.content).toBe(content);

		await t.mutation(api.emailTemplates.emails.restore, { templateId });
		const row = (await t.run(async (ctx) => ctx.db.get(templateId)))!;
		const blocks = JSON.parse(row.content);
		const list = blocks.blocks ?? blocks;
		expect(list[0].content.text).toBe('kept text');
		expect(list[0].savedBlockRef).toBeUndefined();
		expect(list[1].savedBlockRef).toEqual({
			blockId: renamedId,
			groupId: 'g2',
			blockName: 'Footer v2',
		});
		expect(row.linkedBlockIds).toEqual([renamedId]);
		expect((await t.run(async (ctx) => ctx.db.get(renamedId)))?.usageCount).toBe(1);
	});
});

describe('newest-first reads skip deleted campaigns before their limit', () => {
	it('the overview and the comparison window reach past deleted newer sends', async () => {
		const t = await freshT();
		const now = Date.now();
		const keep = await seedCampaign(t, {
			name: 'Live previous',
			status: 'sent',
			sentAt: now - 4_000,
		});
		for (let i = 0; i < 3; i++) {
			const campaignId = await seedCampaign(t, { status: 'sent', sentAt: now - i * 1_000 });
			await t.mutation(api.campaigns.campaigns.remove, { campaignId });
		}

		const overview = await t.query(api.analytics.marketingOverview.get, {});
		expect(overview.latest.map((c) => c.id)).toEqual([keep]);
		const comparable = await t.query(api.campaigns.analytics.getComparableSentCampaigns, {});
		expect(comparable.map((c) => c.id)).toEqual([keep]);
	});
});
