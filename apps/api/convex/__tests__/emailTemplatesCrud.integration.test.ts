/**
 * Integration tests for the public email-template CRUD + i18n surface
 * (apps/api/convex/emailTemplates/{emails,i18n,organization}.ts).
 *
 * The internal lifecycle module (create/transition/duplicate/remove reducers)
 * is exercised directly in emailTemplatesLifecycle.integration.test.ts. This
 * file covers the *session-gated public wrappers*:
 *   - the `templates:manage` role gate on every mutating entry point (an
 *     `editor` is rejected; `admin`/`owner` are allowed) via a mutable-role mock
 *   - the freshly-shipped `email_template.updated` audit rows on update +
 *     changeType
 *   - real-userId attribution on createForOrganization / createFromPreset
 *     (not the `system:http_api` sentinel)
 *   - addTranslation / updateTranslation / removeTranslation / getForLanguage
 *   - setDefaultLanguage: promoting a translation overlay to default must move
 *     the promoted language's text into the main content/subject AND preserve
 *     the outgoing default as a round-trippable overlay — body NOT wiped.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestEmailTemplate } from './factories';

// Mutable session mock — copy of the chat.integration.test.ts pattern so we can
// flip the acting role between owner / admin / editor per case. `hasPermission`
// and `requirePermission` stay REAL (we only override getMutationContext), so
// the real `templates:manage` gate runs against the mocked role.
const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-alice', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi
			.fn()
			.mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi
			.fn()
			.mockImplementation(async () => sessionMock.user.id),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
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
			!path.includes('llmProvider'),
	),
);

const setUser = (
	id: string,
	role: 'owner' | 'admin' | 'editor' = 'owner',
) => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

beforeEach(() => {
	setUser('user-alice', 'owner');
});

// A two-block content document the i18n extractor understands (text + button).
const CONTENT_EN = JSON.stringify([
	{ id: 'b1', type: 'text', content: { html: 'Hello world' } },
	{ id: 'b2', type: 'button', content: { text: 'Click me', url: 'https://x' } },
]);

const seedTemplate = async (
	t: TestConvex<typeof schema>,
	overrides: Record<string, unknown> = {},
): Promise<Id<'emailTemplates'>> =>
	t.run(async (ctx) =>
		ctx.db.insert('emailTemplates', createTestEmailTemplate(overrides)),
	);

const auditRowsFor = async (
	t: TestConvex<typeof schema>,
	resourceId: string,
) =>
	t.run(async (ctx) =>
		(await ctx.db.query('auditLogs').collect()).filter(
			(l) => l.resourceId === resourceId,
		),
	);

// ============================================================================
// Role gate — every mutating public entry point requires templates:manage
// ============================================================================

describe('emailTemplates public mutations — templates:manage role gate', () => {
	it('rejects an editor and allows admin/owner on create', async () => {
		const t = convexTest(schema, modules);

		setUser('user-eve', 'editor');
		await expect(
			t.mutation(api.emailTemplates.emails.create, {
				name: 'X',
				type: 'marketing',
			}),
		).rejects.toThrow();

		setUser('user-adam', 'admin');
		const adminId = await t.mutation(api.emailTemplates.emails.create, {
			name: 'By admin',
			type: 'marketing',
		});
		expect(adminId).toBeDefined();

		setUser('user-olive', 'owner');
		const ownerId = await t.mutation(api.emailTemplates.emails.create, {
			name: 'By owner',
			type: 'marketing',
		});
		expect(ownerId).toBeDefined();
	});

	it('rejects an editor on update / changeType / publish / unpublish / duplicate / remove', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { status: 'draft' });

		setUser('user-eve', 'editor');

		await expect(
			t.mutation(api.emailTemplates.emails.update, {
				templateId,
				name: 'Renamed',
			}),
		).rejects.toThrow();
		await expect(
			t.mutation(api.emailTemplates.emails.changeType, {
				templateId,
				type: 'transactional',
			}),
		).rejects.toThrow();
		await expect(
			t.mutation(api.emailTemplates.emails.publish, {
				templateId,
				htmlContent: '<p>x</p>',
			}),
		).rejects.toThrow();
		await expect(
			t.mutation(api.emailTemplates.emails.unpublish, { templateId }),
		).rejects.toThrow();
		await expect(
			t.mutation(api.emailTemplates.emails.duplicate, { templateId }),
		).rejects.toThrow();
		await expect(
			t.mutation(api.emailTemplates.emails.remove, { templateId }),
		).rejects.toThrow();

		// Nothing was mutated by the rejected calls.
		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.status).toBe('draft');
		expect(row).not.toBeNull();
	});

	it('rejects an editor on createForOrganization / createFromPreset', async () => {
		const t = convexTest(schema, modules);
		setUser('user-eve', 'editor');

		await expect(
			t.mutation(api.emailTemplates.organization.createForOrganization, {
				name: 'X',
				type: 'marketing',
			}),
		).rejects.toThrow();
		await expect(
			t.mutation(api.emailTemplates.organization.createFromPreset, {
				name: 'X',
				subject: 'S',
				content: CONTENT_EN,
				type: 'marketing',
			}),
		).rejects.toThrow();
	});

	it('rejects an editor on i18n add/update/remove/setDefaultLanguage', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: { subject: 'Hallo', previewText: 'p', blocks: {} },
			}),
		});

		setUser('user-eve', 'editor');
		await expect(
			t.mutation(api.emailTemplates.i18n.addTranslation, {
				templateId,
				language: 'fr',
			}),
		).rejects.toThrow();
		await expect(
			t.mutation(api.emailTemplates.i18n.updateTranslation, {
				templateId,
				language: 'de',
				subject: 'neu',
			}),
		).rejects.toThrow();
		await expect(
			t.mutation(api.emailTemplates.i18n.removeTranslation, {
				templateId,
				language: 'de',
			}),
		).rejects.toThrow();
		await expect(
			t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
				templateId,
				language: 'de',
			}),
		).rejects.toThrow();
	});
});

// ============================================================================
// update + changeType audit rows (email_template.updated — just shipped)
// ============================================================================

describe('emailTemplates.update — audit + behavior', () => {
	it('patches fields, trims, and emits email_template.updated with changedFields', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { status: 'draft' });

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			name: '  New Name  ',
			subject: '  New Subject  ',
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.name).toBe('New Name');
		expect(row?.subject).toBe('New Subject');

		const audits = await auditRowsFor(t, templateId);
		const updated = audits.find((a) => a.action === 'email_template.updated');
		expect(updated).toBeDefined();
		expect(updated?.userId).toBe('user-olive');
		// changedFields is a comma-joined scalar list of the patched columns.
		const changed = String(updated?.details?.['changedFields'] ?? '');
		expect(changed).toContain('name');
		expect(changed).toContain('subject');
		expect(changed).toContain('searchableText');
	});

	it('refuses to edit publishable content on a published row without force', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'published',
			publishedAt: Date.now(),
		});

		setUser('user-olive', 'owner');
		await expect(
			t.mutation(api.emailTemplates.emails.update, {
				templateId,
				name: 'Nope',
			}),
		).rejects.toThrow();

		// forceWhilePublished: true is the explicit opt-in.
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			name: 'Forced',
			forceWhilePublished: true,
		});
		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.name).toBe('Forced');
	});

	it('adjusts saved-block usageCount when linkedBlockIds change on a normal save', async () => {
		const t = convexTest(schema, modules);
		const blockId = await t.run(async (ctx) =>
			ctx.db.insert('emailBlocks', {
				name: 'Block', content: '[]', usageCount: 0,
				createdAt: Date.now(), updatedAt: Date.now(),
			}),
		);
		const templateId = await seedTemplate(t, { status: 'draft', linkedBlockIds: [] });

		setUser('user-olive', 'owner');
		// Drag the saved block in → count increments.
		await t.mutation(api.emailTemplates.emails.update, { templateId, linkedBlockIds: [blockId] });
		expect((await t.run((ctx) => ctx.db.get(blockId)))?.usageCount).toBe(1);

		// Remove it again → count decrements.
		await t.mutation(api.emailTemplates.emails.update, { templateId, linkedBlockIds: [] });
		expect((await t.run((ctx) => ctx.db.get(blockId)))?.usageCount).toBe(0);
	});
});

describe('emailTemplates.changeType — audit + behavior', () => {
	it('changes type and emits email_template.updated with type detail', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			type: 'marketing',
		});

		setUser('user-adam', 'admin');
		await t.mutation(api.emailTemplates.emails.changeType, {
			templateId,
			type: 'transactional',
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.type).toBe('transactional');

		const audits = await auditRowsFor(t, templateId);
		const updated = audits.find((a) => a.action === 'email_template.updated');
		expect(updated).toBeDefined();
		expect(updated?.userId).toBe('user-adam');
		expect(updated?.details?.['changedFields']).toBe('type');
		expect(updated?.details?.['type']).toBe('transactional');
	});
});

// ============================================================================
// publish / unpublish / duplicate / remove via the public wrappers
// ============================================================================

describe('emailTemplates publish/unpublish/duplicate/remove — public wrappers', () => {
	it('publish promotes draft → published and stamps htmlContent', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { status: 'draft' });

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.emails.publish, {
			templateId,
			htmlContent: '<p>published html</p>',
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.status).toBe('published');
		expect(row?.htmlContent).toBe('<p>published html</p>');
		expect(row?.publishedAt).toBeTypeOf('number');
	});

	it('unpublish reverts published → draft', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'published',
			publishedAt: Date.now(),
		});

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.emails.unpublish, { templateId });

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.status).toBe('draft');
		expect(row?.publishedAt).toBeUndefined();
	});

	it('duplicate creates a (Copy) draft and returns its id', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			name: 'Source',
			status: 'published',
			publishedAt: Date.now(),
		});

		setUser('user-olive', 'owner');
		const copyId = await t.mutation(api.emailTemplates.emails.duplicate, {
			templateId,
		});
		expect(copyId).toBeDefined();
		expect(copyId).not.toBe(templateId);

		const copy = await t.run(async (ctx) => ctx.db.get(copyId));
		expect(copy?.name).toBe('Source (Copy)');
		expect(copy?.status).toBe('draft');
	});

	it('remove deletes the row', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.emails.remove, { templateId });

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row).toBeNull();
	});

	it('publish on a missing template throws not-found', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		await t.run(async (ctx) => ctx.db.delete(templateId));

		setUser('user-olive', 'owner');
		await expect(
			t.mutation(api.emailTemplates.emails.publish, {
				templateId,
				htmlContent: '<p>x</p>',
			}),
		).rejects.toThrow();
	});
});

// ============================================================================
// createForOrganization / createFromPreset — real-userId attribution
// ============================================================================

describe('emailTemplates.organization create paths — attribute the acting userId', () => {
	it('createForOrganization attributes the real session userId in the created audit', async () => {
		const t = convexTest(schema, modules);

		setUser('user-real-org', 'admin');
		const templateId = await t.mutation(
			api.emailTemplates.organization.createForOrganization,
			{ name: 'Org Template', type: 'marketing', defaultLanguage: 'en' },
		);

		const audits = await auditRowsFor(t, templateId);
		const created = audits.find((a) => a.action === 'email_template.created');
		expect(created).toBeDefined();
		expect(created?.userId).toBe('user-real-org');
		// Not the HTTP-API sentinel.
		expect(created?.userId).not.toBe('system:http_api');
	});

	it('createFromPreset attributes the real session userId in the created audit', async () => {
		const t = convexTest(schema, modules);

		setUser('user-real-preset', 'owner');
		const templateId = await t.mutation(
			api.emailTemplates.organization.createFromPreset,
			{
				name: 'Preset Template',
				subject: 'Preset Subject',
				content: CONTENT_EN,
				type: 'marketing',
			},
		);

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.subject).toBe('Preset Subject');
		expect(row?.content).toBe(CONTENT_EN);

		const audits = await auditRowsFor(t, templateId);
		const created = audits.find((a) => a.action === 'email_template.created');
		expect(created?.userId).toBe('user-real-preset');
		expect(created?.userId).not.toBe('system:http_api');
	});
});

// ============================================================================
// i18n — add / update / remove / getForLanguage
// ============================================================================

describe('emailTemplates.i18n — translations CRUD', () => {
	it('addTranslation seeds a translation copying default text + extends supportedLanguages', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			subject: 'English subject',
			previewText: 'English preview',
			content: CONTENT_EN,
			defaultLanguage: 'en',
			supportedLanguages: ['en'],
		});

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.i18n.addTranslation, {
			templateId,
			language: 'de',
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.supportedLanguages).toContain('de');
		const translations = JSON.parse(row?.translations ?? '{}');
		expect(translations['de']).toBeDefined();
		// Seeded from the default language's text.
		expect(translations['de'].subject).toBe('English subject');
		// Translatable block text was extracted (text html + button text).
		expect(translations['de'].blocks['b1']?.html).toBe('Hello world');
		expect(translations['de'].blocks['b2']?.buttonText).toBe('Click me');
	});

	it('addTranslation rejects a duplicate language', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: { subject: 'Hallo', previewText: 'p', blocks: {} },
			}),
		});

		setUser('user-olive', 'owner');
		await expect(
			t.mutation(api.emailTemplates.i18n.addTranslation, {
				templateId,
				language: 'de',
			}),
		).rejects.toThrow();
	});

	it('updateTranslation patches a non-default translation overlay', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: { subject: 'Alt', previewText: 'alt', blocks: {} },
			}),
		});

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.i18n.updateTranslation, {
			templateId,
			language: 'de',
			subject: '  Neu  ',
			blocks: JSON.stringify({ b1: { html: 'Hallo Welt' } }),
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		const translations = JSON.parse(row?.translations ?? '{}');
		expect(translations['de'].subject).toBe('Neu');
		expect(translations['de'].blocks['b1'].html).toBe('Hallo Welt');
	});

	it('updateTranslation on the default language patches the main subject', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			subject: 'Old subject',
			defaultLanguage: 'en',
			supportedLanguages: ['en'],
		});

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.i18n.updateTranslation, {
			templateId,
			language: 'en',
			subject: '  Main subject  ',
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.subject).toBe('Main subject');
	});

	it('updateTranslation throws for a non-existent non-default language', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			defaultLanguage: 'en',
			supportedLanguages: ['en'],
		});

		setUser('user-olive', 'owner');
		await expect(
			t.mutation(api.emailTemplates.i18n.updateTranslation, {
				templateId,
				language: 'fr',
				subject: 'x',
			}),
		).rejects.toThrow();
	});

	it('removeTranslation drops the overlay + supportedLanguages entry; cannot remove default', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: { subject: 'Hallo', previewText: 'p', blocks: {} },
			}),
		});

		setUser('user-olive', 'owner');
		// Default language is protected.
		await expect(
			t.mutation(api.emailTemplates.i18n.removeTranslation, {
				templateId,
				language: 'en',
			}),
		).rejects.toThrow();

		await t.mutation(api.emailTemplates.i18n.removeTranslation, {
			templateId,
			language: 'de',
		});
		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.supportedLanguages).not.toContain('de');
		const translations = JSON.parse(row?.translations ?? '{}');
		expect(translations['de']).toBeUndefined();
	});

	it('getForLanguage returns the default content for the default language', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			subject: 'English subject',
			content: CONTENT_EN,
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: {
					subject: 'Deutscher Betreff',
					previewText: 'Vorschau',
					blocks: { b1: { html: 'Hallo Welt' }, b2: { buttonText: 'Klick' } },
				},
			}),
		});

		setUser('user-olive', 'owner');
		const resolved = await t.query(api.emailTemplates.i18n.getForLanguage, {
			templateId,
			language: 'en',
		});
		expect(resolved?.resolvedLanguage).toBe('en');
		expect(resolved?.subject).toBe('English subject');
		expect(resolved?.content).toBe(CONTENT_EN);
	});

	it('getForLanguage merges translated text into the default styling for a non-default language', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			subject: 'English subject',
			content: CONTENT_EN,
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: {
					subject: 'Deutscher Betreff',
					previewText: 'Vorschau',
					blocks: { b1: { html: 'Hallo Welt' }, b2: { buttonText: 'Klick' } },
				},
			}),
		});

		setUser('user-olive', 'owner');
		const resolved = await t.query(api.emailTemplates.i18n.getForLanguage, {
			templateId,
			language: 'de',
		});
		expect(resolved?.resolvedLanguage).toBe('de');
		expect(resolved?.subject).toBe('Deutscher Betreff');
		const blocks = JSON.parse(resolved?.content ?? '[]');
		const byId = Object.fromEntries(blocks.map((b: { id: string }) => [b.id, b]));
		// Translated text merged in, structure/styling preserved from main content.
		expect(byId['b1'].content.html).toBe('Hallo Welt');
		expect(byId['b2'].content.text).toBe('Klick');
		expect(byId['b2'].content.url).toBe('https://x');
	});

	it('getForLanguage falls back to default content for a language with no overlay', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			subject: 'English subject',
			content: CONTENT_EN,
			defaultLanguage: 'en',
			supportedLanguages: ['en'],
		});

		setUser('user-olive', 'owner');
		const resolved = await t.query(api.emailTemplates.i18n.getForLanguage, {
			templateId,
			language: 'fr',
		});
		expect(resolved?.resolvedLanguage).toBe('en');
		expect(resolved?.subject).toBe('English subject');
		expect(resolved?.content).toBe(CONTENT_EN);
	});
});

// ============================================================================
// i18n.setDefaultLanguage — promote a translation to default (round-trip)
// ============================================================================

describe('emailTemplates.i18n.setDefaultLanguage — promotion round-trips, body not wiped', () => {
	it('promotes the German overlay to default, preserves English as a round-trippable overlay', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			subject: 'English subject',
			previewText: 'English preview',
			content: CONTENT_EN,
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: {
					subject: 'Deutscher Betreff',
					previewText: 'Deutsche Vorschau',
					blocks: { b1: { html: 'Hallo Welt' }, b2: { buttonText: 'Klick mich' } },
				},
			}),
		});

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId,
			language: 'de',
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));

		// The default language flipped to German.
		expect(row?.defaultLanguage).toBe('de');
		// Main subject/previewText became the promoted language's.
		expect(row?.subject).toBe('Deutscher Betreff');
		expect(row?.previewText).toBe('Deutsche Vorschau');

		// CRITICAL: the body must NOT be wiped — main content is the original
		// structure with the German translatable text merged in.
		expect(row?.content).toBeTruthy();
		const mainBlocks = JSON.parse(row?.content ?? '[]');
		expect(mainBlocks).toHaveLength(2);
		const mainById = Object.fromEntries(
			mainBlocks.map((b: { id: string }) => [b.id, b]),
		);
		expect(mainById['b1'].content.html).toBe('Hallo Welt');
		expect(mainById['b2'].content.text).toBe('Klick mich');
		// Non-translatable styling/props from the original survive.
		expect(mainById['b2'].content.url).toBe('https://x');

		// The promoted language's overlay was dropped; the old default (en) is
		// preserved as an overlay carrying the original English text.
		const translations = JSON.parse(row?.translations ?? '{}');
		expect(translations['de']).toBeUndefined();
		expect(translations['en']).toBeDefined();
		expect(translations['en'].subject).toBe('English subject');
		expect(translations['en'].previewText).toBe('English preview');
		expect(translations['en'].blocks['b1']?.html).toBe('Hello world');
		expect(translations['en'].blocks['b2']?.buttonText).toBe('Click me');
	});

	it('round-trips: re-selecting English restores the original English subject + body', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			subject: 'English subject',
			previewText: 'English preview',
			content: CONTENT_EN,
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: {
					subject: 'Deutscher Betreff',
					previewText: 'Deutsche Vorschau',
					blocks: { b1: { html: 'Hallo Welt' }, b2: { buttonText: 'Klick mich' } },
				},
			}),
		});

		setUser('user-olive', 'owner');
		// en -> de
		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId,
			language: 'de',
		});
		// de -> en (re-select the original)
		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId,
			language: 'en',
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.defaultLanguage).toBe('en');
		expect(row?.subject).toBe('English subject');
		expect(row?.previewText).toBe('English preview');

		const mainBlocks = JSON.parse(row?.content ?? '[]');
		const mainById = Object.fromEntries(
			mainBlocks.map((b: { id: string }) => [b.id, b]),
		);
		// Original English text restored into the body.
		expect(mainById['b1'].content.html).toBe('Hello world');
		expect(mainById['b2'].content.text).toBe('Click me');
		expect(mainById['b2'].content.url).toBe('https://x');

		// German is once again an overlay.
		const translations = JSON.parse(row?.translations ?? '{}');
		expect(translations['de']).toBeDefined();
		expect(translations['de'].subject).toBe('Deutscher Betreff');
		expect(translations['de'].blocks['b1']?.html).toBe('Hallo Welt');
	});

	it('setDefaultLanguage to the current default is a no-op', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			subject: 'English subject',
			content: CONTENT_EN,
			defaultLanguage: 'en',
			supportedLanguages: ['en'],
		});

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId,
			language: 'en',
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.defaultLanguage).toBe('en');
		expect(row?.subject).toBe('English subject');
		expect(row?.content).toBe(CONTENT_EN);
	});

	it('setDefaultLanguage to a language without a translation overlay throws', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			defaultLanguage: 'en',
			supportedLanguages: ['en'],
		});

		setUser('user-olive', 'owner');
		await expect(
			t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
				templateId,
				language: 'de',
			}),
		).rejects.toThrow();
	});

	it('promotes a subject-only overlay (no per-block text) without wiping the body', async () => {
		// The Settings page builds overlays that carry subject/previewText but no
		// `blocks` map. Promoting one must still preserve the original body.
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			status: 'draft',
			subject: 'English subject',
			previewText: 'English preview',
			content: CONTENT_EN,
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({
				de: { subject: 'Deutscher Betreff', previewText: 'Deutsche Vorschau' },
			}),
		});

		setUser('user-olive', 'owner');
		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId,
			language: 'de',
		});

		const row = await t.run(async (ctx) => ctx.db.get(templateId));
		expect(row?.defaultLanguage).toBe('de');
		expect(row?.subject).toBe('Deutscher Betreff');
		expect(row?.previewText).toBe('Deutsche Vorschau');

		// No per-block German text existed, so the body keeps the original copy.
		const mainBlocks = JSON.parse(row?.content ?? '[]');
		const mainById = Object.fromEntries(
			mainBlocks.map((b: { id: string }) => [b.id, b]),
		);
		expect(mainById['b1'].content.html).toBe('Hello world');
		expect(mainById['b2'].content.text).toBe('Click me');

		// English is demoted to a round-trippable overlay.
		const translations = JSON.parse(row?.translations ?? '{}');
		expect(translations['de']).toBeUndefined();
		expect(translations['en'].subject).toBe('English subject');
		expect(translations['en'].blocks['b1']?.html).toBe('Hello world');
	});
});
