/**
 * Text-block HTML is sanitized when template, transactional email and saved
 * block content is written (lib/emailContentSanitize.ts), on every public
 * write path the editor and the template library use.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestEmailTemplate } from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'test-user',
			issuer: 'test',
			tokenIdentifier: 'test|test-user',
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');

const UNSAFE = '<p>Hi</p><img src="x" onerror="window.__x=1"><a href="javascript:alert(1)">x</a>';
const LEGITIMATE =
	'<p><strong>Bold</strong> <em>i</em> <a href="https://example.com">link</a> ' +
	'<span style="color:#ff0000">red</span></p><ul><li>one</li></ul>';

const blocksJson = (html: string) =>
	JSON.stringify([
		{
			id: 'b1',
			type: 'text',
			content: { html, blockType: 'paragraph', fontSize: 16 },
		},
		{
			id: 'c1',
			type: 'columns',
			content: { columns: [[{ id: 'b2', type: 'text', content: { html } }]] },
		},
	]);

function textHtmls(json: string): string[] {
	const parsed = JSON.parse(json);
	const blocks = Array.isArray(parsed) ? parsed : parsed.blocks;
	return [blocks[0].content.html, blocks[1].content.columns[0][0].content.html];
}

function expectClean(json: string | undefined) {
	for (const html of textHtmls(json!)) {
		expect(html).toContain('Hi');
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('javascript:');
	}
}

const seedTemplate = (t: TestConvex<typeof schema>, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) => ctx.db.insert('emailTemplates', createTestEmailTemplate(overrides)));

describe('email templates', () => {
	it('createFromPreset stores sanitized text HTML', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.emailTemplates.organization.createFromPreset, {
			name: 'Preset',
			subject: 'S',
			content: blocksJson(UNSAFE),
			type: 'marketing',
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expectClean(row!.content);
	});

	it('create stores sanitized text HTML', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.emailTemplates.emails.create, {
			name: 'New',
			type: 'marketing',
			content: blocksJson(UNSAFE),
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expectClean(row!.content);
	});

	it('update sanitizes content and translation overlays', async () => {
		const t = convexTest(schema, modules);
		const id = await seedTemplate(t);
		await t.mutation(api.emailTemplates.emails.update, {
			templateId: id,
			content: blocksJson(UNSAFE),
			translations: JSON.stringify({ de: { subject: 'S', blocks: { b1: { html: UNSAFE } } } }),
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		expectClean(row!.content);
		const overlay = JSON.parse(row!.translations!).de.blocks.b1.html as string;
		expect(overlay).not.toContain('onerror');
		expect(overlay).not.toContain('javascript:');
	});

	it('update stores legitimate content unchanged', async () => {
		const t = convexTest(schema, modules);
		const id = await seedTemplate(t);
		const content = blocksJson(LEGITIMATE);
		await t.mutation(api.emailTemplates.emails.update, { templateId: id, content });
		const row = await t.run((ctx) => ctx.db.get(id));
		expect(row!.content).toBe(content);
	});

	it('updateTranslation sanitizes overlay block HTML', async () => {
		const t = convexTest(schema, modules);
		const id = await seedTemplate(t, {
			content: blocksJson('Hello'),
			defaultLanguage: 'en',
			supportedLanguages: ['en', 'de'],
			translations: JSON.stringify({ de: { subject: 'S', blocks: {} } }),
		});
		await t.mutation(api.emailTemplates.i18n.updateTranslation, {
			templateId: id,
			language: 'de',
			blocks: JSON.stringify({ b1: { html: UNSAFE } }),
		});
		const row = await t.run((ctx) => ctx.db.get(id));
		const overlay = JSON.parse(row!.translations!).de.blocks.b1.html as string;
		expect(overlay).toContain('Hi');
		expect(overlay).not.toContain('onerror');
		expect(overlay).not.toContain('javascript:');
	});

	it('duplicate sanitizes content copied from an older row', async () => {
		const t = convexTest(schema, modules);
		const id = await seedTemplate(t, { content: blocksJson(UNSAFE) });
		const copyId = await t.mutation(api.emailTemplates.emails.duplicate, { templateId: id });
		const copy = await t.run((ctx) => ctx.db.get(copyId));
		expectClean(copy!.content);
	});
});

describe('transactional emails', () => {
	it('create and update store sanitized text HTML', async () => {
		const t = convexTest(schema, modules);
		const id = await t.mutation(api.transactional.emails.create, {
			name: 'Receipt',
			slug: 'receipt',
			content: blocksJson(UNSAFE),
		});
		expectClean((await t.run((ctx) => ctx.db.get(id)))!.content);

		await t.mutation(api.transactional.emails.update, { id, content: blocksJson(UNSAFE) });
		expectClean((await t.run((ctx) => ctx.db.get(id)))!.content);
	});
});

describe('saved blocks', () => {
	it('create and update store sanitized text HTML', async () => {
		const t = convexTest(schema, modules);
		const envelope = (html: string) => JSON.stringify({ blocks: JSON.parse(blocksJson(html)) });
		const blockId = await t.mutation(api.emailBlocks.blocks.create, {
			name: 'Footer',
			content: envelope(UNSAFE),
		});
		expectClean((await t.run((ctx) => ctx.db.get(blockId)))!.content);

		await t.mutation(api.emailBlocks.blocks.update, { blockId, content: envelope(UNSAFE) });
		expectClean((await t.run((ctx) => ctx.db.get(blockId)))!.content);
	});
});
