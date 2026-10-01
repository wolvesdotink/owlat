// The translation table lists a row for every translatable field at any depth,
// through the same child contract the backend merge uses, so a Hero's children
// (and anything nested in them) can be translated.
import { describe, it, expect } from 'vitest';
import type { BlockTreeNode } from '@owlat/shared/blockTree';
import { mergeTranslationIntoItem, type BlockLikeItem } from '@owlat/api/translationMerge';
import { translationBlockRows } from '../translationRows';

// Labels spelled out from the key and its params, so a test reads the path.
const t = (key: string, params: Record<string, unknown>): string => {
	const name = key.split('.').pop();
	const { prefix = '', ...rest } = params;
	return `${String(prefix)}${name}(${Object.values(rest).join(',')})`;
};

const text = (id: string, html: string) => ({ id, type: 'text', content: { html } });

const document: BlockTreeNode[] = [
	text('intro', '<p>Intro</p>'),
	{
		id: 'hero',
		type: 'hero',
		content: {
			items: [
				text('hero-text', '<p>Welcome</p>'),
				{ id: 'hero-btn', type: 'button', content: { text: 'Shop now' } },
				{ id: 'hero-img', type: 'image', content: { src: 'a.png', alt: 'Logo' } },
				{
					id: 'hero-box',
					type: 'container',
					content: {
						items: [
							{
								id: 'hero-cols',
								type: 'columns',
								content: { columns: [[text('deep-left', '<p>Left</p>')], []] },
							},
						],
					},
				},
			],
		},
	},
	{
		id: 'faq',
		type: 'accordion',
		content: {
			sections: [
				{ id: 's1', title: 'One', items: [] },
				{ id: 's2', title: 'Two', items: [text('faq-text', '<p>Answer</p>')] },
			],
		},
	},
];

describe('translationBlockRows', () => {
	it('lists text, button and image fields inside a hero and a composite nested in it', () => {
		const rows = translationBlockRows(document, t);
		expect(rows.map((r) => [r.blockId, r.fieldType, r.sourceText, r.label])).toEqual([
			['intro', 'html', '<p>Intro</p>', 'textBlock(1)'],
			['hero-text', 'html', '<p>Welcome</p>', 'heroPrefix(1) > textBlock(1)'],
			['hero-btn', 'buttonText', 'Shop now', 'heroPrefix(1) > buttonBlock(Shop now)'],
			['hero-img', 'alt', 'Logo', 'heroPrefix(1) > imageBlock(1)'],
			[
				'deep-left',
				'html',
				'<p>Left</p>',
				'heroPrefix(1) > containerPrefix(1) > columnPrefix(1) > textBlock(1)',
			],
			['faq-text', 'html', '<p>Answer</p>', 'accordionSectionPrefix(1,2) > textBlock(1)'],
		]);
	});

	it('lists exactly the fields the overlay merge translates', () => {
		const rows = translationBlockRows(document, t);
		const overlay = Object.fromEntries(
			rows.map((r) => [r.blockId, { [r.fieldType]: `de:${r.blockId}` }])
		);
		const merged = (document as BlockLikeItem[]).map((block) =>
			mergeTranslationIntoItem(block, overlay)
		);
		expect(translationBlockRows(merged, t).map((r) => [r.blockId, r.sourceText])).toEqual(
			rows.map((r) => [r.blockId, `de:${r.blockId}`])
		);
	});

	it('numbers sibling composites of each type separately', () => {
		const rows = translationBlockRows(
			[
				{ id: 'c1', type: 'container', content: { items: [text('a', 'A')] } },
				{ id: 'h1', type: 'hero', content: { items: [text('b', 'B')] } },
				{ id: 'c2', type: 'container', content: { items: [text('c', 'C')] } },
			],
			t
		);
		expect(rows.map((r) => r.label)).toEqual([
			'containerPrefix(1) > textBlock(1)',
			'heroPrefix(1) > textBlock(1)',
			'containerPrefix(2) > textBlock(1)',
		]);
	});
});
