/**
 * `parseContentBlocks` gives every Block an id. Legacy saved Blocks
 * were stored as one `{ type, content }` object without an id, and an API
 * write or a hand-edited template can leave one out too; the renderer used to
 * throw on such a Block, so a publish or rerender failed without saying why.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderPublishableEmail } from '../../lib/publishableEmailRender';
import { parseContentBlocks } from '../consumers';

const button = { type: 'button', content: { text: 'Read more', url: 'https://example.com' } };
const text = (html: string, id?: string) => ({
	...(id !== undefined && { id }),
	type: 'text',
	content: { html },
});

/** The legacy single-Block fixture of the stored-block corpus. */
const LEGACY_SINGLE = JSON.stringify(
	(
		JSON.parse(
			readFileSync(
				resolve(
					dirname(fileURLToPath(import.meta.url)),
					'../../../../../packages/email-renderer/src/__tests__/storedBlocks/v1/saved-block-legacy-single.json'
				),
				'utf8'
			)
		) as { stored: unknown }
	).stored
);

describe('parseContentBlocks', () => {
	it.each([
		['the legacy single Block', JSON.stringify(button)],
		['a bare array', JSON.stringify([button])],
		['the { blocks } envelope', JSON.stringify({ blocks: [button] })],
	])('gives an id-less Block in %s an id', (_shape, content) => {
		const [block, ...rest] = parseContentBlocks(content);
		expect(rest).toEqual([]);
		expect(block).toMatchObject(button);
		expect(block!.id).toMatch(/^block-/);
	});

	it('gives the same ids on every read of one stored document', () => {
		const content = JSON.stringify([text('<p>a</p>'), text('<p>b</p>', 'b'), text('<p>c</p>')]);
		const first = parseContentBlocks(content);
		expect(parseContentBlocks(content)).toEqual(first);
		expect(first.map((block) => block.id)).toEqual(['block-1', 'b', 'block-2']);
	});

	it('fills a nested id-less Block too', () => {
		const content = JSON.stringify([
			{ id: 'box', type: 'container', content: { items: [text('<p>inside</p>')] } },
		]);
		const [box] = parseContentBlocks(content);
		const [item] = (box!.content as { items: Array<{ id?: unknown }> }).items;
		expect(item!.id).toMatch(/^block-/);
	});

	it('keeps repeated ids, so a read never detaches a copy from its translation', () => {
		const content = JSON.stringify([text('<p>one</p>', 'b1'), text('<p>two</p>', 'b1')]);
		expect(parseContentBlocks(content).map((block) => block.id)).toEqual(['b1', 'b1']);
	});

	it('keeps valid siblings of a Block whose type names an Object.prototype member', () => {
		const content = JSON.stringify([
			text('<p>valid</p>'),
			{ id: 'unknown', type: 'constructor', content: {} },
		]);
		expect(parseContentBlocks(content).map((block) => block.id)).toEqual(['block-1', 'unknown']);
	});

	it('still reads anything else as no Blocks', () => {
		expect(parseContentBlocks('not json')).toEqual([]);
		expect(parseContentBlocks('{}')).toEqual([]);
		expect(parseContentBlocks('null')).toEqual([]);
	});
});

describe('server render of id-less stored content', () => {
	it.each([
		['the legacy single-Block corpus fixture', LEGACY_SINGLE],
		['a bare array', JSON.stringify([button, text('<p>Next</p>')])],
		['the { blocks } envelope', JSON.stringify({ blocks: [button] })],
	])('renders %s instead of throwing', (_shape, content) => {
		const rendered = renderPublishableEmail(
			{ content, subject: 'Subject' },
			'personalization',
			undefined
		);
		expect(rendered.html).toContain('Read more');
		expect(rendered.html).toContain('data-block-id="block-1"');
	});

	it('applies a translation overlay keyed by the filled id', () => {
		const rendered = renderPublishableEmail(
			{
				content: JSON.stringify([text('<p>Hello</p>')]),
				subject: 'Subject',
				translations: JSON.stringify({
					de: { subject: 'Betreff', blocks: { 'block-1': { html: '<p>Hallo</p>' } } },
				}),
				supportedLanguages: ['en', 'de'],
				defaultLanguage: 'en',
			},
			'personalization',
			undefined
		);
		const translated = JSON.parse(rendered.htmlTranslations!) as Record<
			string,
			{ htmlContent: string }
		>;
		expect(translated['de']!.htmlContent).toContain('Hallo');
	});
});
