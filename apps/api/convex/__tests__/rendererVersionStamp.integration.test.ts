/**
 * Integration tests for the `rendererVersion` stamp (lib/rendererVersion.ts):
 * every write that stores rendered HTML on a publishable email records the
 * renderer version that produced it, and copies of that HTML carry it along.
 *
 *   - editor saves stamp the version the client reports, or 1 when it reports
 *     none (a client from before the field)
 *   - a write that leaves older HTML in the row (one language, or only the
 *     translations) keeps the older version
 *   - the saved-block rerender pool stamps the version the action rendered with
 *   - `setDefaultLanguage` and a publish that stores the caller's HTML stamp it
 *   - share links and duplicates carry the source row's version
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { CURRENT_RENDERER_VERSION } from '../lib/constants';
import { createTestEmailTemplate, createTestTransactionalEmail } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

const CONTENT = JSON.stringify([{ id: 'b1', type: 'text', content: { html: 'Hello' } }]);
const DE_OVERLAY = JSON.stringify({ de: { subject: 'Hallo', blocks: {} } });
const DE_HTML = JSON.stringify({ de: { htmlContent: '<p>Hallo</p>', subject: 'Hallo' } });

const seedTemplate = (t: TestConvex<typeof schema>, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) =>
		ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({ status: 'draft', content: CONTENT, ...overrides })
		)
	);

const seedTransactional = (t: TestConvex<typeof schema>, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) =>
		ctx.db.insert(
			'transactionalEmails',
			createTestTransactionalEmail({ status: 'draft', content: CONTENT, ...overrides })
		)
	);

/** A row whose stored HTML (default and German) came from renderer version 1. */
const RENDERED_V1 = {
	htmlContent: '<p>Hello</p>',
	defaultLanguage: 'en',
	supportedLanguages: ['en', 'de'],
	translations: DE_OVERLAY,
	htmlTranslations: DE_HTML,
	rendererVersion: 1,
};

describe('renderer version', () => {
	it('is 2 since accordion radio groups were scoped to their Block', () => {
		expect(CURRENT_RENDERER_VERSION).toBe(2);
	});
});

describe('editor saves', () => {
	it('stamp the version the client rendered with', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT,
			htmlContent: '<p>Hello v2</p>',
			htmlTranslations: DE_HTML,
			rendererVersion: 2,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.rendererVersion).toBe(2);
	});

	it('stamp version 1 when an older client reports no version', async () => {
		const t = convexTest(schema, modules);
		const emailId = await seedTransactional(t, { ...RENDERED_V1, rendererVersion: 2 });

		await t.mutation(api.transactional.emails.update, {
			id: emailId,
			content: CONTENT,
			htmlContent: '<p>Hello</p>',
			htmlTranslations: DE_HTML,
		});

		const row = await t.run((ctx) => ctx.db.get(emailId));
		expect(row?.rendererVersion).toBe(1);
	});

	it('keep the older version when the default HTML is left as it was', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);

		// The Settings page re-renders only the translations.
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			htmlTranslations: DE_HTML,
			rendererVersion: 2,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.rendererVersion).toBe(1);
	});

	it('leave the version alone when they store no HTML', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);

		await t.mutation(api.emailTemplates.emails.update, { templateId, name: 'Renamed' });

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.rendererVersion).toBe(1);
	});
});

describe('translation writes', () => {
	it('keep the older version when one language is re-rendered', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);

		await t.mutation(api.emailTemplates.i18n.updateTranslation, {
			templateId,
			language: 'de',
			subject: 'Hallo!',
			htmlContent: '<p>Hallo v2</p>',
			rendererVersion: 2,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.rendererVersion).toBe(1);
	});

	it('lower the version when one language comes from an older renderer', async () => {
		const t = convexTest(schema, modules);
		const emailId = await seedTransactional(t, { ...RENDERED_V1, rendererVersion: 2 });

		await t.mutation(api.transactional.translations.addTranslation, {
			id: emailId,
			language: 'fr',
			htmlContent: '<p>Bonjour</p>',
		});

		const row = await t.run((ctx) => ctx.db.get(emailId));
		expect(row?.rendererVersion).toBe(1);
	});

	it('stamp the version when the language is the only HTML the row stores', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { htmlContent: undefined, rendererVersion: 1 });

		await t.mutation(api.emailTemplates.i18n.addTranslation, {
			templateId,
			language: 'de',
			htmlContent: '<p>Hallo</p>',
			rendererVersion: 2,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.rendererVersion).toBe(2);
	});

	it('stamp the version on a default-language swap that re-renders every language', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);

		await t.mutation(api.emailTemplates.i18n.setDefaultLanguage, {
			templateId,
			language: 'de',
			htmlContent: '<p>Hallo</p>',
			plainTextContent: 'Hallo',
			htmlTranslations: JSON.stringify({
				en: { htmlContent: '<p>Hello</p>', subject: 'Hello' },
			}),
			rendererVersion: 2,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.defaultLanguage).toBe('de');
		expect(row?.rendererVersion).toBe(2);
	});
});

describe('saved-block rerender pool', () => {
	it('stamps the version the action rendered with', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			...RENDERED_V1,
			contentRevision: 3,
			htmlRenderState: { stale: true, failureCount: 0 },
		});

		await t.mutation(internal.emailBlocks.renderingPool.patchTemplateHtml, {
			templateId,
			htmlContent: '<p>Rerendered</p>',
			htmlTranslations: DE_HTML,
			expectedContentRevision: 3,
			rendererVersion: 2,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.rendererVersion).toBe(2);
	});

	it('stamps version 1 for an action started before it reported one', async () => {
		const t = convexTest(schema, modules);
		const emailId = await seedTransactional(t, {
			htmlContent: '<p>Hello</p>',
			rendererVersion: 2,
			contentRevision: 3,
			htmlRenderState: { stale: true, failureCount: 0 },
		});

		await t.mutation(internal.emailBlocks.renderingPool.patchTransactionalHtml, {
			emailId,
			htmlContent: '<p>Rerendered</p>',
			expectedContentRevision: 3,
		});

		const row = await t.run((ctx) => ctx.db.get(emailId));
		expect(row?.rendererVersion).toBe(1);
	});
});

describe('publish', () => {
	it("stamps the caller's version when it stores the caller's HTML", async () => {
		const t = convexTest(schema, modules);
		// Never rendered: created outside the editor.
		const emailId = await seedTransactional(t, { htmlContent: undefined, rendererVersion: 1 });

		await t.mutation(api.transactional.emails.publish, {
			id: emailId,
			htmlContent: '<p>Hello there, thanks for signing up.</p>',
			htmlTranslations: '{}',
			rendererVersion: 2,
		});

		const row = await t.run((ctx) => ctx.db.get(emailId));
		expect(row?.htmlContent).toBe('<p>Hello there, thanks for signing up.</p>');
		expect(row?.rendererVersion).toBe(2);
	});

	it("keeps the row's version when it publishes the row's own HTML", async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);

		await t.mutation(api.emailTemplates.emails.publish, {
			templateId,
			htmlContent: '<p>Ignored</p>',
			rendererVersion: 2,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.status).toBe('published');
		expect(row?.rendererVersion).toBe(1);
	});
});

describe('copies of stored HTML', () => {
	it("share links snapshot the source row's version", async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);
		const emailId = await seedTransactional(t, { htmlContent: '<p>Hi</p>' });

		const fromTemplate = await t.mutation(api.shareLinks.createShareLink, {
			emailTemplateId: templateId,
		});
		const fromUnstamped = await t.mutation(api.shareLinks.createShareLink, {
			transactionalEmailId: emailId,
		});

		const [templateLink, unstampedLink] = await t.run(async (ctx) => [
			await ctx.db.get(fromTemplate.shareLinkId),
			await ctx.db.get(fromUnstamped.shareLinkId),
		]);
		expect(templateLink?.rendererVersion).toBe(1);
		// HTML stored before rows were stamped came from version 1.
		expect(unstampedLink?.rendererVersion).toBe(1);
	});

	it("duplicates keep the source's version, and version 1 for an unstamped source", async () => {
		const t = convexTest(schema, modules);
		const stampedId = await seedTemplate(t, { ...RENDERED_V1, rendererVersion: 2 });
		const unstampedId = await seedTemplate(t, { htmlContent: '<p>Hello</p>' });

		const stampedCopy = await t.mutation(api.emailTemplates.emails.duplicate, {
			templateId: stampedId,
		});
		const unstampedCopy = await t.mutation(api.emailTemplates.emails.duplicate, {
			templateId: unstampedId,
		});

		const [a, b] = await t.run(async (ctx) => [
			await ctx.db.get(stampedCopy),
			await ctx.db.get(unstampedCopy),
		]);
		expect(a?.rendererVersion).toBe(2);
		expect(b?.rendererVersion).toBe(1);
	});
});
