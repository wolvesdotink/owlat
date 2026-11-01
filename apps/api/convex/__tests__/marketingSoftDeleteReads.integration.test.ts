/**
 * A campaign, automation or template in Recently deleted reads as missing on
 * every public query keyed by its id or by the id of something that hangs off
 * it (reports, analytics, history, sends), and on the scans that list its
 * name (topic contact history).
 *
 * The source guard below lists every such public query, so a new one cannot
 * land without a probe here that proves it checks the parent first.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as SessionOrganization from '../lib/sessionOrganization';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestEmailTemplate,
	createTestTopic,
	enableFeatures,
} from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const { realPermissionGate } = await import('./helpers/permissionGateMock');
	const gate = realPermissionGate(actual, () => 'owner');
	const session = async () => ({
		userId: 'user-alice',
		role: 'owner' as const,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-alice'),
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
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

type T = TestConvex<typeof schema>;

interface World {
	t: T;
	topicId: Id<'topics'>;
	contactId: Id<'contacts'>;
	campaignId: Id<'campaigns'>;
	sendId: Id<'emailSends'>;
	automationId: Id<'automations'>;
	templateId: Id<'emailTemplates'>;
	versionId: Id<'emailTemplateVersions'>;
}

async function seedWorld(): Promise<World> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['campaigns', 'automations']);
	const now = Date.now();
	const ids = await t.run(async (ctx) => {
		const topicId = await ctx.db.insert('topics', createTestTopic());
		const contactId = await ctx.db.insert('contacts', createTestContact());
		await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: now });
		const templateId = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({ name: 'Autumn body' }) as never
		);
		const versionId = await ctx.db.insert('emailTemplateVersions', {
			templateId,
			// A send snapshot, so the latest-send read has something to show live.
			trigger: 'send',
			content: '[]',
			name: 'Autumn body',
			subject: 'Autumn',
			contentBytes: 2,
			contentHash: 'hash-0',
			createdBy: 'user-alice',
			createdAt: now,
		});
		const campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				name: 'Autumn sale',
				subject: 'Autumn is here',
				status: 'sent',
				sentAt: now - 60_000,
				audience: { kind: 'topic', topicId },
				emailTemplateId: templateId,
			}) as never
		);
		const sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				status: 'opened',
				sentAt: now - 60_000,
				deliveredAt: now - 50_000,
				openedAt: now - 40_000,
				openCount: 1,
			}) as never
		);
		const automationId = await ctx.db.insert(
			'automations',
			createTestAutomation({ name: 'Welcome', statsEntered: 4, statsCompleted: 3 }) as never
		);
		await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({ automationId, statCompleted: 3 }) as never
		);
		await ctx.db.insert('automationRuns', {
			automationId,
			contactId,
			currentStepIndex: 1,
			status: 'completed',
			startedAt: now - 30_000,
			completedAt: now - 20_000,
			triggeredBy: 'contact_created',
		});
		return { topicId, contactId, campaignId, sendId, automationId, templateId, versionId };
	});
	return { t, ...ids };
}

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

async function settle(run: () => Promise<unknown>): Promise<Settled> {
	try {
		return { ok: true, value: await run() };
	} catch (error) {
		return { ok: false, error };
	}
}

/** The answer a query gives for an unknown id. */
function readsAsMissing(result: Settled): boolean {
	if (!result.ok) return /not found/i.test(String(result.error));
	const { value } = result;
	if (value === null) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === 'object' && value !== null && 'runs' in value) {
		return (value as { runs: unknown[] }).runs.length === 0;
	}
	return false;
}

interface Probe {
	read: (w: World) => Promise<unknown>;
	/** True when the seeded live row answers with something to hide. */
	shownWhileLive: boolean;
}

/**
 * Every public query keyed by a soft-deletable row or one of its children.
 * Keys are `<file>:<export>` relative to `convex/`.
 */
const PROBES: Record<string, Probe> = {
	'automations/analytics.ts:getAutomationRuns': {
		read: ({ t, automationId }) =>
			t.query(api.automations.analytics.getAutomationRuns, { automationId }),
		shownWhileLive: true,
	},
	'automations/analytics.ts:getAutomationStats': {
		read: ({ t, automationId }) =>
			t.query(api.automations.analytics.getAutomationStats, { automationId }),
		shownWhileLive: true,
	},
	'automations/analytics.ts:getStepAnalytics': {
		read: ({ t, automationId }) =>
			t.query(api.automations.analytics.getStepAnalytics, { automationId }),
		shownWhileLive: true,
	},
	'automations/health.ts:summaries': {
		read: ({ t, automationId }) =>
			t.query(api.automations.health.summaries, { automationIds: [automationId] }),
		shownWhileLive: true,
	},
	'automations/automations.ts:get': {
		read: ({ t, automationId }) => t.query(api.automations.automations.get, { automationId }),
		shownWhileLive: true,
	},
	'automations/automations.ts:getWithRelations': {
		read: ({ t, automationId }) =>
			t.query(api.automations.automations.getWithRelations, { automationId }),
		shownWhileLive: true,
	},
	'campaigns/abTest.ts:getABTestStats': {
		read: ({ t, campaignId }) => t.query(api.campaigns.abTest.getABTestStats, { campaignId }),
		// Not an A/B test, so a live campaign answers null too.
		shownWhileLive: false,
	},
	'campaigns/campaigns.ts:getWithRelations': {
		read: ({ t, campaignId }) => t.query(api.campaigns.campaigns.getWithRelations, { campaignId }),
		shownWhileLive: true,
	},
	'campaigns/sendPlanQueries.ts:getCampaignSendPlan': {
		read: ({ t, campaignId }) =>
			t.query(api.campaigns.sendPlanQueries.getCampaignSendPlan, { campaignId }),
		// No walk in flight, so a live campaign answers null too.
		shownWhileLive: false,
	},
	'campaigns/sendTimeQueries.ts:previewSendTimes': {
		read: ({ t, campaignId }) =>
			t.query(api.campaigns.sendTimeQueries.previewSendTimes, {
				campaignId,
				startAt: Date.now(),
				windowHours: 24,
				holdoutPercent: 0,
			}),
		shownWhileLive: true,
	},
	'delivery/sends.ts:get': {
		// The send stays as delivery history; what hides is its campaign.
		read: async ({ t, sendId }) =>
			(await t.query(api.delivery.sends.get, { id: sendId }))?.campaign ?? null,
		shownWhileLive: true,
	},
	'delivery/sends.ts:getClickedContacts': {
		read: ({ t, campaignId }) => t.query(api.delivery.sends.getClickedContacts, { campaignId }),
		shownWhileLive: true,
	},
	'delivery/sends.ts:getLinkClickStats': {
		read: ({ t, campaignId }) => t.query(api.delivery.sends.getLinkClickStats, { campaignId }),
		shownWhileLive: true,
	},
	'delivery/sends.ts:getOpenedContacts': {
		read: ({ t, campaignId }) => t.query(api.delivery.sends.getOpenedContacts, { campaignId }),
		shownWhileLive: true,
	},
	'delivery/sends.ts:getOpensTimeline': {
		read: ({ t, campaignId }) => t.query(api.delivery.sends.getOpensTimeline, { campaignId }),
		shownWhileLive: true,
	},
	'delivery/sends.ts:getStatsByCampaign': {
		read: ({ t, campaignId }) => t.query(api.delivery.sends.getStatsByCampaign, { campaignId }),
		shownWhileLive: true,
	},
	'emailTemplates/emails.ts:get': {
		read: ({ t, templateId }) => t.query(api.emailTemplates.emails.get, { templateId }),
		shownWhileLive: true,
	},
	'emailTemplates/i18n.ts:getForLanguage': {
		read: ({ t, templateId }) => t.query(api.emailTemplates.i18n.getForLanguage, { templateId }),
		shownWhileLive: true,
	},
	'emailTemplates/versions.ts:get': {
		read: ({ t, versionId }) => t.query(api.emailTemplates.versions.get, { versionId }),
		shownWhileLive: true,
	},
	'emailTemplates/versions.ts:latestSend': {
		read: ({ t, templateId }) => t.query(api.emailTemplates.versions.latestSend, { templateId }),
		shownWhileLive: true,
	},
	'emailTemplates/versions.ts:list': {
		read: ({ t, templateId }) => t.query(api.emailTemplates.versions.list, { templateId }),
		shownWhileLive: true,
	},
	'shareLinks/links.ts:listShareLinks': {
		read: ({ t, templateId }) =>
			t.query(api.shareLinks.links.listShareLinks, { emailTemplateId: templateId }),
		// No share link was minted, so a live template answers [] too.
		shownWhileLive: false,
	},
};

async function deleteAll({ t, campaignId, automationId, templateId }: World): Promise<void> {
	await t.mutation(api.campaigns.campaigns.remove, { campaignId });
	await t.mutation(api.automations.automations.remove, { automationId });
	await t.mutation(api.emailTemplates.emails.remove, { templateId });
}

describe('reads keyed by a deleted marketing row', () => {
	it.each(Object.keys(PROBES))('%s answers as for an unknown id', async (key) => {
		const probe = PROBES[key]!;
		const world = await seedWorld();
		const live = await settle(() => probe.read(world));
		if (probe.shownWhileLive) {
			expect(live).toEqual(expect.objectContaining({ ok: true }));
			expect(readsAsMissing(live)).toBe(false);
		}

		await deleteAll(world);

		expect(readsAsMissing(await settle(() => probe.read(world)))).toBe(true);
	});

	it('topic contact history leaves out deleted campaigns', async () => {
		const world = await seedWorld();
		const { t, topicId, contactId, campaignId } = world;
		const history = async () =>
			(await t.query(api.topics.topics.getContactInTopicDetails, { topicId, contactId }))!
				.emailHistory;
		expect((await history()).map((entry) => entry.campaignName)).toEqual(['Autumn sale']);

		await t.mutation(api.campaigns.campaigns.remove, { campaignId });
		expect(await history()).toEqual([]);

		await t.mutation(api.campaigns.campaigns.restore, { campaignId });
		expect((await history()).map((entry) => entry.campaignName)).toEqual(['Autumn sale']);
	});

	it('restoring an automation brings its analytics back', async () => {
		const world = await seedWorld();
		const { t, automationId } = world;
		await t.mutation(api.automations.automations.remove, { automationId });
		await t.mutation(api.automations.automations.restore, { automationId });

		const stats = await t.query(api.automations.analytics.getAutomationStats, { automationId });
		expect(stats).toEqual(expect.objectContaining({ totalEntered: 4, completed: 3 }));
		const steps = await t.query(api.automations.analytics.getStepAnalytics, { automationId });
		expect(steps.map((step) => step.stats.completed)).toEqual([3]);
	});
});

// ------------------------------------------------------------------
// Source guard: the probe table above covers every public query whose
// arguments name a soft-deletable row or a child of one.
// ------------------------------------------------------------------

const ROOT = join(__dirname, '..');
const KEYED_TABLES = [
	'campaigns',
	'automations',
	'emailTemplates',
	'campaignSendJobs',
	'emailSends',
	'automationSteps',
	'automationRuns',
	'emailTemplateVersions',
];
const KEYED_ARG = new RegExp(`v\\.id\\('(${KEYED_TABLES.join('|')})'\\)`);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			return name === '_generated' || name === '__tests__' || name === 'node_modules'
				? []
				: sourceFiles(path);
		}
		return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
	});
}

function publicQueriesKeyedByMarketingRows(): string[] {
	const keys: string[] = [];
	for (const path of sourceFiles(ROOT)) {
		const text = readFileSync(path, 'utf8');
		for (const match of text.matchAll(/^export const (\w+) = (\w+)\(\{/gm)) {
			const builder = match[2]!;
			if (builder.startsWith('internal') || !/[Qq]uery$/.test(builder)) continue;
			const start = match.index + match[0].length;
			const args = text.slice(start, text.indexOf('handler', start));
			if (KEYED_ARG.test(args)) keys.push(`${relative(ROOT, path)}:${match[1]}`);
		}
	}
	return keys.sort();
}

describe('soft-delete read coverage guard', () => {
	it('every public query keyed by a marketing row has a probe', () => {
		expect(publicQueriesKeyedByMarketingRows()).toEqual(Object.keys(PROBES).sort());
	});
});
