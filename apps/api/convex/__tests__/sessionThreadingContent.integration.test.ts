/**
 * The analytics, saved-block, email-template, form, import, plugin and webhook
 * handlers take the caller from the session their builder floor resolved (the
 * handler's third argument) instead of resolving it again.
 *
 * Each case runs once as an owner, asserting by call count that the floor was
 * the only session resolution and, where the handler records who acted, that
 * the actor is the floor's user. Privileged cases also run as an editor and
 * must be refused with the message the handler used before, writing nothing;
 * member-level reads must still answer an editor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import * as sessionOrganization from '../lib/sessionOrganization';
import { createTestEmailTemplate, createTestWebhook, enableFeatures } from './factories';
import { newHarness } from './testModules';
import { clearResolverCalls, expectOnlyFloor, setSession, type Floor } from './threadedSessionMock';

vi.mock('../lib/sessionOrganization', async () => {
	const { threadedSessionMock } = await import('./threadedSessionMock');
	return {
		...(await threadedSessionMock()),
		// The draft-strategy handlers scope to the deployment's one organization.
		getSingletonOrganizationId: vi.fn(async () => 'org-1'),
	};
});

type T = TestConvex<typeof schema>;

interface Case<S> {
	name: string;
	floor: Floor;
	/** The message an editor is refused with; absent for member-level handlers. */
	denied?: string;
	/** The owner's call is refused past the auth gate (no fixture can satisfy it). */
	rejects?: RegExp;
	seed?: (t: T) => Promise<S>;
	call: (t: T, seeded: S) => Promise<unknown>;
	/** Extra assertions on what the owner's call wrote or returned. */
	check?: (t: T, seeded: S, result: unknown) => Promise<void>;
	/** What the refused editor's call must have left untouched. */
	unchanged?: (t: T, seeded: S) => Promise<void>;
}

const defineCase = <S>(c: Case<S>) => c as unknown as Case<unknown>;

const ADMIN = 'Only owners and admins can perform this action';
const DEFAULT_DENIAL = "You don't have permission to perform this action";
const TRANSLATIONS = 'Only owners and admins can manage template translations';
const FORMS = 'Only owners and admins can manage forms';
const WEBHOOKS = 'Only owners and admins can manage webhooks';

async function auditActors(t: T, action: string): Promise<string[]> {
	const rows = await t.run((ctx) => ctx.db.query('auditLogs').collect());
	return rows.filter((row) => row.action === action).map((row) => row.userId);
}

const count = (t: T, table: 'emailBlocks' | 'emailTemplates' | 'formEndpoints' | 'webhooks') =>
	t.run(async (ctx) => (await ctx.db.query(table).collect()).length);

const seedBlock = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert('emailBlocks', {
			name: 'Footer',
			content: JSON.stringify({ type: 'text', content: 'Bye' }),
			usageCount: 0,
			createdAt: 1,
			updatedAt: 1,
		})
	);

const seedTemplate =
	(overrides: Record<string, unknown> = {}) =>
	(t: T) =>
		t.run((ctx) => ctx.db.insert('emailTemplates', createTestEmailTemplate(overrides)));

/** A template with a German overlay, added through the public mutation. */
async function seedTranslatedTemplate(t: T): Promise<Id<'emailTemplates'>> {
	const templateId = await seedTemplate()(t);
	await t.mutation(api.emailTemplates.i18n.addTranslation, { templateId, language: 'de' });
	return templateId;
}

const seedForm = (t: T) => t.mutation(api.forms.endpoints.create, { name: 'Signup' });

const seedWebhook = (t: T) => t.run((ctx) => ctx.db.insert('webhooks', createTestWebhook()));

const seedRunningImport = (t: T) =>
	t.run((ctx) =>
		ctx.db.insert('integrationImports', {
			provider: 'mailchimp',
			status: 'running',
			cursor: '',
			imported: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
			errors: [],
			handleDuplicates: 'skip',
			startedAt: 1,
		})
	);

const cases: Case<unknown>[] = [
	// ─── analytics ────────────────────────────────────────────────────────────
	defineCase({
		name: 'analytics.dashboard.getStats',
		floor: 'requireOrgMember',
		call: (t) => t.query(api.analytics.dashboard.getStats, {}),
	}),
	defineCase({
		name: 'analytics.dashboard.getRecentActivity',
		floor: 'requireOrgPermission',
		denied: DEFAULT_DENIAL,
		call: (t) => t.query(api.analytics.dashboard.getRecentActivity, {}),
	}),
	defineCase({
		name: 'analytics.complianceTelemetry.getComplianceTelemetry',
		floor: 'requireOrgMember',
		call: (t) => t.query(api.analytics.complianceTelemetry.getComplianceTelemetry, {}),
	}),
	defineCase({
		name: 'analytics.reputationSnapshots.getDeliverySnapshots',
		floor: 'requireOrgMember',
		call: (t) => t.query(api.analytics.reputationSnapshots.getDeliverySnapshots, {}),
	}),

	// ─── saved blocks ─────────────────────────────────────────────────────────
	defineCase({
		name: 'emailBlocks.blocks.create',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can create saved blocks',
		call: (t) =>
			t.mutation(api.emailBlocks.blocks.create, {
				name: 'Header',
				content: JSON.stringify({ type: 'text', content: 'Hi' }),
			}),
		unchanged: async (t) => {
			expect(await count(t, 'emailBlocks')).toBe(0);
		},
	}),
	defineCase({
		name: 'emailBlocks.blocks.update',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can update saved blocks',
		seed: seedBlock,
		call: (t, blockId: Id<'emailBlocks'>) =>
			t.mutation(api.emailBlocks.blocks.update, { blockId, name: 'Renamed' }),
		unchanged: async (t, blockId: Id<'emailBlocks'>) => {
			expect((await t.run((ctx) => ctx.db.get(blockId)))?.name).toBe('Footer');
		},
	}),
	defineCase({
		name: 'emailBlocks.blocks.duplicate',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can duplicate saved blocks',
		seed: seedBlock,
		call: (t, blockId: Id<'emailBlocks'>) =>
			t.mutation(api.emailBlocks.blocks.duplicate, { blockId }),
		unchanged: async (t) => {
			expect(await count(t, 'emailBlocks')).toBe(1);
		},
	}),
	defineCase({
		name: 'emailBlocks.blocks.remove',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can delete saved blocks',
		seed: seedBlock,
		call: (t, blockId: Id<'emailBlocks'>) => t.mutation(api.emailBlocks.blocks.remove, { blockId }),
		unchanged: async (t) => {
			expect(await count(t, 'emailBlocks')).toBe(1);
		},
	}),

	// ─── email templates ──────────────────────────────────────────────────────
	defineCase({
		name: 'emailTemplates.emails.create',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can create email templates',
		call: (t) =>
			t.mutation(api.emailTemplates.emails.create, { name: 'Welcome', type: 'marketing' }),
		check: async (t) => {
			expect(await auditActors(t, 'email_template.created')).toEqual(['admin-user']);
		},
		unchanged: async (t) => {
			expect(await count(t, 'emailTemplates')).toBe(0);
		},
	}),
	defineCase({
		name: 'emailTemplates.emails.update',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can update email templates',
		seed: seedTemplate({ name: 'Original' }),
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.emails.update, { templateId, name: 'Renamed' }),
		check: async (t) => {
			expect(await auditActors(t, 'email_template.updated')).toEqual(['admin-user']);
		},
		unchanged: async (t, templateId: Id<'emailTemplates'>) => {
			expect((await t.run((ctx) => ctx.db.get(templateId)))?.name).toBe('Original');
		},
	}),
	defineCase({
		name: 'emailTemplates.emails.publish',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can publish email templates',
		seed: seedTemplate(),
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.emails.publish, { templateId }),
		check: async (t, templateId: Id<'emailTemplates'>) => {
			expect((await t.run((ctx) => ctx.db.get(templateId)))?.status).toBe('published');
		},
		unchanged: async (t, templateId: Id<'emailTemplates'>) => {
			expect((await t.run((ctx) => ctx.db.get(templateId)))?.status).toBe('draft');
		},
	}),
	defineCase({
		name: 'emailTemplates.emails.unpublish',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can unpublish email templates',
		seed: seedTemplate({ status: 'published' }),
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.emails.unpublish, { templateId }),
		check: async (t, templateId: Id<'emailTemplates'>) => {
			expect((await t.run((ctx) => ctx.db.get(templateId)))?.status).toBe('draft');
		},
		unchanged: async (t, templateId: Id<'emailTemplates'>) => {
			expect((await t.run((ctx) => ctx.db.get(templateId)))?.status).toBe('published');
		},
	}),
	defineCase({
		name: 'emailTemplates.emails.duplicate',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can duplicate email templates',
		seed: seedTemplate(),
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.emails.duplicate, { templateId }),
		unchanged: async (t) => {
			expect(await count(t, 'emailTemplates')).toBe(1);
		},
	}),
	defineCase({
		name: 'emailTemplates.emails.remove',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can delete email templates',
		seed: seedTemplate(),
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.emails.remove, { templateId }),
		check: async (t) => {
			expect(await auditActors(t, 'email_template.deleted')).toEqual(['admin-user']);
		},
		unchanged: async (t, templateId: Id<'emailTemplates'>) => {
			expect((await t.run((ctx) => ctx.db.get(templateId)))?.deletedAt).toBeUndefined();
		},
	}),
	defineCase({
		name: 'emailTemplates.emails.changeType',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can change template type',
		seed: seedTemplate(),
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.emails.changeType, { templateId, type: 'transactional' }),
		check: async (t) => {
			expect(await auditActors(t, 'email_template.updated')).toEqual(['admin-user']);
		},
		unchanged: async (t, templateId: Id<'emailTemplates'>) => {
			expect((await t.run((ctx) => ctx.db.get(templateId)))?.type).toBe('marketing');
		},
	}),
	defineCase({
		name: 'emailTemplates.organization.createFromPreset',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can create email templates',
		call: (t) =>
			t.mutation(api.emailTemplates.organization.createFromPreset, {
				name: 'Preset',
				subject: 'Hello',
				content: JSON.stringify({ blocks: [] }),
				type: 'marketing',
			}),
		check: async (t) => {
			expect(await auditActors(t, 'email_template.created')).toEqual(['admin-user']);
		},
		unchanged: async (t) => {
			expect(await count(t, 'emailTemplates')).toBe(0);
		},
	}),
	defineCase({
		name: 'emailTemplates.i18n.addTranslation',
		floor: 'getMutationContext',
		denied: TRANSLATIONS,
		seed: seedTemplate(),
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.i18n.addTranslation, { templateId, language: 'de' }),
		unchanged: async (t, templateId: Id<'emailTemplates'>) => {
			expect((await t.run((ctx) => ctx.db.get(templateId)))?.translations).toBeUndefined();
		},
	}),
	defineCase({
		name: 'emailTemplates.i18n.updateTranslation',
		floor: 'getMutationContext',
		denied: TRANSLATIONS,
		seed: seedTranslatedTemplate,
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.i18n.updateTranslation, {
				templateId,
				language: 'de',
				subject: 'Hallo',
			}),
	}),
	defineCase({
		name: 'emailTemplates.i18n.removeTranslation',
		floor: 'getMutationContext',
		denied: TRANSLATIONS,
		seed: seedTranslatedTemplate,
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.i18n.removeTranslation, { templateId, language: 'de' }),
	}),
	defineCase({
		name: 'emailTemplates.i18n.setDefaultLanguage',
		floor: 'getMutationContext',
		denied: TRANSLATIONS,
		seed: seedTranslatedTemplate,
		call: (t, templateId: Id<'emailTemplates'>) =>
			t.mutation(api.emailTemplates.i18n.setDefaultLanguage, { templateId, language: 'de' }),
	}),

	// ─── forms ────────────────────────────────────────────────────────────────
	defineCase({
		name: 'forms.endpoints.create',
		floor: 'getMutationContext',
		denied: FORMS,
		call: (t) => t.mutation(api.forms.endpoints.create, { name: 'Newsletter' }),
		unchanged: async (t) => {
			expect(await count(t, 'formEndpoints')).toBe(0);
		},
	}),
	defineCase({
		name: 'forms.endpoints.update',
		floor: 'getMutationContext',
		denied: FORMS,
		seed: seedForm,
		call: (t, formEndpointId: Id<'formEndpoints'>) =>
			t.mutation(api.forms.endpoints.update, { formEndpointId, name: 'Renamed' }),
		unchanged: async (t, formEndpointId: Id<'formEndpoints'>) => {
			expect((await t.run((ctx) => ctx.db.get(formEndpointId)))?.name).toBe('Signup');
		},
	}),
	defineCase({
		name: 'forms.endpoints.remove',
		floor: 'getMutationContext',
		denied: FORMS,
		seed: seedForm,
		call: (t, formEndpointId: Id<'formEndpoints'>) =>
			t.mutation(api.forms.endpoints.remove, { formEndpointId }),
		unchanged: async (t, formEndpointId: Id<'formEndpoints'>) => {
			expect((await t.run((ctx) => ctx.db.get(formEndpointId)))?.isActive).toBe(true);
		},
	}),

	// ─── integration imports ──────────────────────────────────────────────────
	defineCase({
		name: 'integrationImports.walker.startIntegrationImport',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can start imports',
		call: (t) =>
			t.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: { provider: 'mailchimp', apiKey: 'abc-us21', listId: 'list_1' },
				handleDuplicates: 'skip',
			}),
		unchanged: async (t) => {
			expect(await t.run((ctx) => ctx.db.query('integrationImports').collect())).toEqual([]);
		},
	}),
	defineCase({
		name: 'integrationImports.walker.cancelImport',
		floor: 'getMutationContext',
		denied: 'Only owners and admins can cancel imports',
		seed: seedRunningImport,
		call: (t, importId: Id<'integrationImports'>) =>
			t.mutation(api.integrationImports.walker.cancelImport, { importId }),
		check: async (t, importId: Id<'integrationImports'>) => {
			expect((await t.run((ctx) => ctx.db.get(importId)))?.errors).toContain('Cancelled by user');
		},
		unchanged: async (t, importId: Id<'integrationImports'>) => {
			expect((await t.run((ctx) => ctx.db.get(importId)))?.status).toBe('running');
		},
	}),

	// ─── plugins ──────────────────────────────────────────────────────────────
	defineCase({
		name: 'plugins.draftStrategySelections.listCatalog',
		floor: 'requireOrgMember',
		denied: DEFAULT_DENIAL,
		call: (t) => t.query(api.plugins.draftStrategySelections.listCatalog, {}),
	}),
	defineCase({
		name: 'plugins.draftStrategySelections.setSelection',
		floor: 'getMutationContext',
		denied: ADMIN,
		call: (t) =>
			t.mutation(api.plugins.draftStrategySelections.setSelection, {
				scope: { type: 'classification', id: 'support' },
				strategyKind: 'default',
			}),
	}),
	defineCase({
		name: 'plugins.settings.setPluginSettings',
		floor: 'getMutationContext',
		denied: ADMIN,
		// No plugin with settings is bundled here, so the owner gets as far as
		// the manifest lookup.
		rejects: /Plugin is not installed/,
		call: (t) =>
			t.mutation(api.plugins.settings.setPluginSettings, {
				pluginId: 'policy-pack',
				values: { endpoint: 'https://plugin.example.com' },
			}),
	}),
	defineCase({
		name: 'plugins.settings.resetPluginSettings',
		floor: 'getMutationContext',
		denied: ADMIN,
		// The harness's feature flags already created the settings row.
		seed: (t) =>
			t.run(async (ctx) => {
				const row = await ctx.db.query('instanceSettings').first();
				await ctx.db.patch(row!._id, {
					pluginSettings: { 'plugin.removed-pack': { endpoint: 'https://plugin.example.com' } },
				});
			}),
		call: (t) => t.mutation(api.plugins.settings.resetPluginSettings, { pluginId: 'removed-pack' }),
		check: async (t) => {
			const [audit] = await t.run((ctx) => ctx.db.query('auditLogs').collect());
			expect(audit).toMatchObject({
				userId: 'admin-user',
				organizationId: 'org-1',
				action: 'settings.updated',
			});
		},
		unchanged: async (t) => {
			const row = await t.run((ctx) => ctx.db.query('instanceSettings').first());
			expect(row?.pluginSettings).toHaveProperty(['plugin.removed-pack']);
		},
	}),

	// ─── webhooks ─────────────────────────────────────────────────────────────
	defineCase({
		name: 'webhooks.endpoints.listByOrganization',
		floor: 'requireOrgMember',
		denied: WEBHOOKS,
		seed: seedWebhook,
		call: (t) => t.query(api.webhooks.endpoints.listByOrganization, {}),
		check: async (_t, _seeded, result) => {
			expect(result).toHaveLength(1);
		},
	}),
	defineCase({
		name: 'webhooks.endpoints.create',
		floor: 'getMutationContext',
		denied: WEBHOOKS,
		call: (t) =>
			t.mutation(api.webhooks.endpoints.create, {
				name: 'CRM',
				url: 'https://crm.example.com/hook',
				events: ['email.sent'],
			}),
		check: async (t) => {
			expect(await auditActors(t, 'webhook.created')).toEqual(['admin-user']);
		},
		unchanged: async (t) => {
			expect(await count(t, 'webhooks')).toBe(0);
		},
	}),
	defineCase({
		name: 'webhooks.endpoints.update',
		floor: 'getMutationContext',
		denied: WEBHOOKS,
		seed: seedWebhook,
		call: (t, webhookId: Id<'webhooks'>) =>
			t.mutation(api.webhooks.endpoints.update, { webhookId, name: 'Renamed' }),
		check: async (t) => {
			expect(await auditActors(t, 'webhook.updated')).toEqual(['admin-user']);
		},
		unchanged: async (t, webhookId: Id<'webhooks'>) => {
			expect((await t.run((ctx) => ctx.db.get(webhookId)))?.name).not.toBe('Renamed');
		},
	}),
	defineCase({
		name: 'webhooks.endpoints.regenerateSecret',
		floor: 'getMutationContext',
		denied: WEBHOOKS,
		seed: seedWebhook,
		call: (t, webhookId: Id<'webhooks'>) =>
			t.mutation(api.webhooks.endpoints.regenerateSecret, { webhookId }),
		check: async (t) => {
			expect(await auditActors(t, 'webhook.secret_rotated')).toEqual(['admin-user']);
		},
	}),
	defineCase({
		name: 'webhooks.endpoints.toggle',
		floor: 'getMutationContext',
		denied: WEBHOOKS,
		seed: seedWebhook,
		call: (t, webhookId: Id<'webhooks'>) =>
			t.mutation(api.webhooks.endpoints.toggle, { webhookId }),
		unchanged: async (t, webhookId: Id<'webhooks'>) => {
			expect((await t.run((ctx) => ctx.db.get(webhookId)))?.isActive).toBe(true);
		},
	}),
	defineCase({
		name: 'webhooks.endpoints.remove',
		floor: 'getMutationContext',
		denied: WEBHOOKS,
		seed: seedWebhook,
		call: (t, webhookId: Id<'webhooks'>) =>
			t.mutation(api.webhooks.endpoints.remove, { webhookId }),
		check: async (t) => {
			expect(await auditActors(t, 'webhook.deleted')).toEqual(['admin-user']);
		},
		unchanged: async (t) => {
			expect(await count(t, 'webhooks')).toBe(1);
		},
	}),
	defineCase({
		name: 'webhooks.endpoints.sendTestWebhook',
		floor: 'getMutationContext',
		denied: WEBHOOKS,
		seed: seedWebhook,
		call: (t, webhookId: Id<'webhooks'>) =>
			t.mutation(api.webhooks.endpoints.sendTestWebhook, { webhookId }),
	}),
	defineCase({
		name: 'webhooks.endpoints.listDeliveryLogs',
		floor: 'requireOrgMember',
		denied: WEBHOOKS,
		seed: seedWebhook,
		call: (t, webhookId: Id<'webhooks'>) =>
			t.query(api.webhooks.endpoints.listDeliveryLogs, { webhookId }),
	}),
	defineCase({
		name: 'webhooks.endpoints.getDeliveryLog',
		floor: 'requireOrgMember',
		denied: WEBHOOKS,
		seed: async (t) => {
			const webhookId = await seedWebhook(t);
			return await t.run((ctx) =>
				ctx.db.insert('webhookDeliveryLogs', {
					webhookId,
					event: 'email.sent',
					payload: { event: 'email.sent', timestamp: '2026-01-01T00:00:00.000Z', data: {} },
					attemptNumber: 1,
					maxAttempts: 3,
					status: 'success',
					scheduledAt: 1,
				})
			);
		},
		call: (t, logId: Id<'webhookDeliveryLogs'>) =>
			t.query(api.webhooks.endpoints.getDeliveryLog, { logId }),
		check: async (_t, logId, result) => {
			expect(result).toMatchObject({ _id: logId });
		},
	}),
	defineCase({
		name: 'webhooks.endpoints.getDeliveryStats',
		floor: 'requireOrgMember',
		denied: WEBHOOKS,
		seed: seedWebhook,
		call: (t, webhookId: Id<'webhooks'>) =>
			t.query(api.webhooks.endpoints.getDeliveryStats, { webhookId }),
	}),
];

async function harness(): Promise<T> {
	const t = newHarness();
	await enableFeatures(t, ['forms', 'webhooks', 'imports.mailchimp']);
	return t;
}

beforeEach(() => {
	// Scheduled follow-ups (import pages, re-renders, webhook deliveries) are
	// not under test; fake timers keep convex-test from running them.
	vi.useFakeTimers();
	setSession('admin-user', 'owner');
});

afterEach(() => {
	vi.useRealTimers();
});

describe('content and integration handlers use the session their floor resolved', () => {
	it.each(cases.map((c) => [c.name, c] as const))(
		'%s resolves the session once, on its floor',
		async (_name, c) => {
			const t = await harness();
			const seeded = await c.seed?.(t);
			clearResolverCalls(sessionOrganization);

			if (c.rejects) {
				await expect(c.call(t, seeded)).rejects.toThrow(c.rejects);
				expectOnlyFloor(sessionOrganization, c.floor);
				return;
			}
			const result = await c.call(t, seeded);

			expectOnlyFloor(sessionOrganization, c.floor);
			await c.check?.(t, seeded, result);
		}
	);

	const privileged = cases.filter((c) => c.denied !== undefined);
	it.each(privileged.map((c) => [c.name, c] as const))(
		'%s refuses an editor with its existing message',
		async (_name, c) => {
			const t = await harness();
			const seeded = await c.seed?.(t);
			setSession('editor-user', 'editor');

			await expect(c.call(t, seeded)).rejects.toThrow(c.denied);
			await c.unchanged?.(t, seeded);
		}
	);

	const memberLevel = cases.filter((c) => c.denied === undefined);
	it.each(memberLevel.map((c) => [c.name, c] as const))(
		'%s still answers an editor',
		async (_name, c) => {
			const t = await harness();
			const seeded = await c.seed?.(t);
			setSession('editor-user', 'editor');
			clearResolverCalls(sessionOrganization);

			await c.call(t, seeded);
			expectOnlyFloor(sessionOrganization, c.floor);
		}
	);
});
