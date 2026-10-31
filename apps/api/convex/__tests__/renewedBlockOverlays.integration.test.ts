/**
 * The editor renews a repeated Block id when it loads a document (#1430). A
 * save of that document must keep the translation each copy showed: the
 * server carries the overlay of the repeated id to the id the editor gave the
 * copy, in every language, as migration 0055 does for stored rows.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import { normalizeBlockTreeIds } from '@owlat/shared/blockTree';
import schema from '../schema';
import { api } from '../_generated/api';
import { parseContentBlocks } from '../emailBlocks/consumers';
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

const text = (id: string, html: string) => ({
	id,
	type: 'text',
	content: { html, blockType: 'paragraph' },
});

/** A root Block and a Block nested in a container share the id `a`. */
const REPEATED = JSON.stringify([
	text('a', '<p>Hello</p>'),
	{ id: 'box', type: 'container', content: { items: [text('a', '<p>Hello</p>')] } },
]);

const TRANSLATED = {
	defaultLanguage: 'en',
	supportedLanguages: ['en', 'de'],
	translations: JSON.stringify({
		de: { subject: 'Hallo', blocks: { a: { html: '<p>Deutscher Text</p>' } } },
	}),
};

/** What the editor saves: the stored document as it loads it, renewed ids included. */
const editorSave = (content: string): string =>
	JSON.stringify(normalizeBlockTreeIds(parseContentBlocks(content), { renewRepeated: true }));

const nestedIdOf = (content: string): string =>
	(JSON.parse(content) as Array<{ content: { items?: Array<{ id: string }> } }>)[1]!.content
		.items![0]!.id;

const occurrences = (html: string, needle: string) => html.split(needle).length - 1;

const seedTemplate = (t: TestConvex<typeof schema>, overrides: Record<string, unknown> = {}) =>
	t.run(async (ctx) =>
		ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({ content: REPEATED, ...TRANSLATED, ...overrides })
		)
	);

describe('saving a document whose repeated Block id the editor renewed', () => {
	it('carries the overlay to the renewed id, so both copies stay translated', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);

		const content = editorSave(REPEATED);
		const renewed = nestedIdOf(content);
		expect(renewed).not.toBe('a');

		await t.mutation(api.emailTemplates.emails.update, { templateId, content });

		const row = await t.run((ctx) => ctx.db.get(templateId));
		const de = JSON.parse(row!.translations!).de;
		expect(de.blocks['a'].html).toBe('<p>Deutscher Text</p>');
		expect(de.blocks[renewed].html).toBe('<p>Deutscher Text</p>');
		const deHtml = JSON.parse(row!.htmlTranslations!).de.htmlContent as string;
		expect(occurrences(deHtml, 'Deutscher Text')).toBe(2);
		expect(deHtml).not.toContain('Hello');
	});

	it('does the same for a transactional email', async () => {
		const t = convexTest(schema, modules);
		const id = await t.run(async (ctx) =>
			ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail({ content: REPEATED, ...TRANSLATED })
			)
		);

		const content = editorSave(REPEATED);
		await t.mutation(api.transactional.emails.update, { id, content });

		const row = await t.run((ctx) => ctx.db.get(id));
		const de = JSON.parse(row!.translations!).de;
		expect(de.blocks[nestedIdOf(content)].html).toBe('<p>Deutscher Text</p>');
	});

	it('carries the overlay when the document also holds an accordion section without an id', async () => {
		// The editor fills the section id on read and renews the repeat on load,
		// in two steps; the server predicts both in one. The section must not
		// shift the id the repeat gets, or the copy loses its translation.
		const stored = JSON.stringify([
			text('a', '<p>Hello</p>'),
			text('a', '<p>Hello</p>'),
			{ id: 'acc', type: 'accordion', content: { sections: [{ title: 'One', items: [] }] } },
		]);
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t, { content: stored });

		const content = editorSave(stored);
		const renewed = (JSON.parse(content) as Array<{ id: string }>)[1]!.id;
		expect(renewed).not.toBe('a');

		await t.mutation(api.emailTemplates.emails.update, { templateId, content });

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(JSON.parse(row!.translations!).de.blocks[renewed].html).toBe('<p>Deutscher Text</p>');
		const deHtml = JSON.parse(row!.htmlTranslations!).de.htmlContent as string;
		expect(occurrences(deHtml, 'Deutscher Text')).toBe(2);
	});

	it('leaves translations the save itself sends alone', async () => {
		const t = convexTest(schema, modules);
		const templateId = await seedTemplate(t);
		const sent = JSON.stringify({
			de: { subject: 'Hallo', blocks: { a: { html: '<p>Neu</p>' } } },
		});

		const content = editorSave(REPEATED);
		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content,
			translations: sent,
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		const de = JSON.parse(row!.translations!).de;
		expect(Object.keys(de.blocks)).toEqual(['a']);
	});

	it('does not touch the overlays of a document without repeated ids', async () => {
		const t = convexTest(schema, modules);
		const stored = JSON.stringify([text('a', '<p>Hello</p>')]);
		const templateId = await seedTemplate(t, { content: stored });
		const before = await t.run((ctx) => ctx.db.get(templateId));

		await t.mutation(api.emailTemplates.emails.update, {
			templateId,
			content: JSON.stringify([text('a', '<p>Hello</p>'), text('block-1', '<p>New</p>')]),
		});

		const row = await t.run((ctx) => ctx.db.get(templateId));
		expect(row!.translations).toBe(before!.translations);
	});
});
