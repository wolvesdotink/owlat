/**
 * Integration tests for the `rendererVersion` stamp (lib/rendererVersion.ts):
 * every write that stores rendered HTML on a publishable email records the
 * renderer version that produced it, and copies of that HTML carry it along.
 *
 *   - editor saves, translation writes, `setDefaultLanguage`, publish and
 *     duplicate render on the server (lib/publishableEmail.ts) and stamp the
 *     server's version, whatever version a client reports
 *   - a save that stores no HTML leaves the version alone
 *   - the saved-block rerender pool stamps the version the action rendered with
 *   - share links carry the source row's version
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
	it("stamp the server's version, not the one the client reports", async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: CONTENT,
			htmlContent: '<p>Hello v1</p>',
			htmlTranslations: DE_HTML,
			rendererVersion: 1,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.rendererVersion).toBe(CURRENT_RENDERER_VERSION);
		expect(row?.htmlContent).not.toBe('<p>Hello v1</p>');
	});

	it("stamp the server's version when an older client reports none", async () => {
		const t = convexTest(schema, modules);
		const emailId = await seedTransactional(t, RENDERED_V1);

		await t.mutation(api.transactional.emails.update, {
			id: emailId,
			content: CONTENT,
			htmlContent: '<p>Hello</p>',
			htmlTranslations: DE_HTML,
		});

		const row = await t.run((ctx) => ctx.db.get(emailId));
		expect(row?.rendererVersion).toBe(CURRENT_RENDERER_VERSION);
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
	it("stamp the server's version when one language changes", async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);

		await t.mutation(api.emailTemplates.i18n.updateTranslation, {
			templateId,
			language: 'de',
			subject: 'Hallo!',
			htmlContent: '<p>Hallo v1</p>',
			rendererVersion: 1,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.rendererVersion).toBe(CURRENT_RENDERER_VERSION);
	});

	it("stamp the server's version when a language is added", async () => {
		const t = convexTest(schema, modules);
		const emailId = await seedTransactional(t, RENDERED_V1);

		await t.mutation(api.transactional.translations.addTranslation, {
			id: emailId,
			language: 'fr',
			htmlContent: '<p>Bonjour</p>',
		});

		const row = await t.run((ctx) => ctx.db.get(emailId));
		expect(row?.rendererVersion).toBe(CURRENT_RENDERER_VERSION);
	});

	it("stamp the server's version on a default-language swap", async () => {
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
			rendererVersion: 1,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.defaultLanguage).toBe('de');
		expect(row?.rendererVersion).toBe(CURRENT_RENDERER_VERSION);
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
	it("stamps the server's version and ignores the caller's HTML", async () => {
		const t = convexTest(schema, modules);
		// Never rendered: created outside the editor.
		const emailId = await seedTransactional(t, { htmlContent: undefined, rendererVersion: 1 });

		await t.mutation(api.transactional.emails.publish, {
			id: emailId,
			htmlContent: '<p>Caller HTML</p>',
			htmlTranslations: '{}',
			rendererVersion: 1,
		});

		const row = await t.run((ctx) => ctx.db.get(emailId));
		expect(row?.htmlContent).toContain('Hello');
		expect(row?.htmlContent).not.toContain('Caller HTML');
		expect(row?.rendererVersion).toBe(CURRENT_RENDERER_VERSION);
	});

	it("re-renders a row's own HTML with the server's version", async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, RENDERED_V1);

		await t.mutation(api.emailTemplates.emails.publish, {
			templateId,
			htmlContent: '<p>Ignored</p>',
			rendererVersion: 1,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row?.status).toBe('published');
		expect(row?.rendererVersion).toBe(CURRENT_RENDERER_VERSION);
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

	it("duplicates are rendered fresh and stamp the server's version", async () => {
		const t = convexTest(schema, modules);
		const stampedId = await seedTemplate(t, RENDERED_V1);
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
		expect(a?.rendererVersion).toBe(CURRENT_RENDERER_VERSION);
		expect(b?.rendererVersion).toBe(CURRENT_RENDERER_VERSION);
	});
});
