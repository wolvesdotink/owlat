/**
 * The stored HTML of templates and transactional emails is rendered on the
 * server from the stored (sanitized) blocks. HTML a client sends with a save or
 * a publish is not stored.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestEmailTemplate } from './factories';
import { renderPublishableEmail } from '../lib/publishableEmail';

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

const CLIENT_HTML =
	'<html><body><p>client copy</p><img src="x" onerror="window.__x=1"></body></html>';
const UNSAFE_TEXT = '<p>Hello there</p><img src="x" onerror="window.__x=1">';

const blocksJson = (html: string) =>
	JSON.stringify([{ id: 'b1', type: 'text', content: { html, blockType: 'paragraph' } }]);

const seedTemplate = (t: TestConvex<typeof schema>, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) =>
		ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({ content: blocksJson('<p>Stored body</p>'), ...overrides })
		)
	);

describe('email template saves', () => {
	it('stores the server render of the sanitized blocks, not the client HTML', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: blocksJson(UNSAFE_TEXT),
			htmlContent: CLIENT_HTML,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row!.htmlContent).not.toContain('client copy');
		expect(row!.htmlContent).not.toContain('onerror');
		expect(row!.htmlContent).toContain('Hello there');
		expect(row!.htmlContent).toBe(renderPublishableEmail(row!, 'personalization', undefined).html);
	});

	it('replaces an HTML-only save with the render of the stored blocks', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		await t.mutation(api.emailTemplates.emails.update, { templateId, htmlContent: CLIENT_HTML });

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row!.htmlContent).not.toContain('client copy');
		expect(row!.htmlContent).toContain('Stored body');
	});

	it('renders translated HTML from the overlays, not from the client', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, {
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
		});

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			translations: JSON.stringify({
				de: { subject: 'Hallo', blocks: { b1: { html: '<p>Gespeicherter Text</p>' } } },
			}),
			htmlTranslations: JSON.stringify({
				de: { htmlContent: CLIENT_HTML, subject: 'Hallo' },
			}),
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		const de = JSON.parse(row!.htmlTranslations!).de;
		expect(de.htmlContent).toContain('Gespeicherter Text');
		expect(de.htmlContent).not.toContain('client copy');
	});

	it('renders a never-rendered row on publish instead of taking the client HTML', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { htmlContent: undefined });

		await t.mutation(api.emailTemplates.emails.publish, { templateId, htmlContent: CLIENT_HTML });

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row!.status).toBe('published');
		expect(row!.htmlContent).not.toContain('client copy');
		expect(row!.htmlContent).toContain('Stored body');
	});
});

describe('transactional email saves', () => {
	it('stores the server render of the sanitized blocks, not the client HTML', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.transactional.emails.create, {
			name: 'Receipt',
			slug: 'receipt',
			content: blocksJson('<p>Stored body</p>'),
		});

		await t.mutation(api.transactional.emails.update, {
			id,
			content: blocksJson(UNSAFE_TEXT),
			htmlContent: CLIENT_HTML,
		});

		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row!.htmlContent).not.toContain('client copy');
		expect(row!.htmlContent).not.toContain('onerror');
		expect(row!.htmlContent).toBe(renderPublishableEmail(row!, 'data', undefined).html);
	});
});
