// The translation table lists a row for every translatable field at any depth,
// through the same child contract the backend merge uses, so a Hero's children
// (and anything nested in them) can be translated.
import { describe, it, expect } from 'vitest';
import type { BlockTreeNode } from '@owlat/shared/blockTree';
import {
	mergeTranslationIntoItem,
	type BlockLikeItem,
	type TranslatableBlockContent,
} from '@owlat/api/translationMerge';
import {
	sharedContentKinds,
	translationBlockRows,
	translationProgress,
	type TranslationBlockRow,
} from '../translationRows';

// Labels spelled out from the key and its params, so a test reads the path.
const t = (key: string, params: Record<string, unknown>): string => {
	const name = key.split('.').pop();
	const { prefix = '', ...rest } = params;
	return `${String(prefix)}${name}(${Object.values(rest).join(',')})`;
};

const text = (id: string, html: string) => ({ id, type: 'text', content: { html } });

/** The overlay that gives every row the value `valueOf` names, where the merge reads it. */
function overlayFor(
	rows: readonly TranslationBlockRow[],
	valueOf: (row: TranslationBlockRow) => string
): Record<string, TranslatableBlockContent> {
	const overlay: Record<string, TranslatableBlockContent> = {};
	for (const row of rows) {
		const entry = (overlay[row.blockId] ??= {});
		if (row.fieldType === 'itemText') (entry.texts ??= {})[row.entryKey!] = valueOf(row);
		else if (row.fieldType === 'sectionTitle') {
			(entry.sectionTitles ??= {})[row.entryKey!] = valueOf(row);
		} else entry[row.fieldType] = valueOf(row);
	}
	return overlay;
}

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
			['faq', 'sectionTitle', 'One', 'accordionSectionTitle(1,1)'],
			['faq', 'sectionTitle', 'Two', 'accordionSectionTitle(1,2)'],
			['faq-text', 'html', '<p>Answer</p>', 'accordionSectionPrefix(1,2) > textBlock(1)'],
		]);
	});

	it('lists exactly the fields the overlay merge translates', () => {
		const rows = translationBlockRows(document, t);
		const overlay = overlayFor(rows, (row) => `de:${row.id}`);
		const merged = (document as BlockLikeItem[]).map((block) =>
			mergeTranslationIntoItem(block, overlay)
		);
		expect(translationBlockRows(merged, t).map((r) => [r.blockId, r.sourceText])).toEqual(
			rows.map((r) => [r.blockId, `de:${r.id}`])
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

describe('list, table, menu and accordion rows', () => {
	const blocks: BlockTreeNode[] = [
		{ id: 'list', type: 'list', content: { items: ['Free shipping', 'Returns', 'Free shipping'] } },
		{
			id: 'table',
			type: 'table',
			content: {
				headers: ['Product', 'Price'],
				rows: [['Shirt', '49']],
				footerRow: ['Total', ''],
				captionText: 'Order',
			},
		},
		{ id: 'menu', type: 'menu', content: { items: [{ label: 'Shop', url: 'https://owlat.com' }] } },
		{
			id: 'acc',
			type: 'accordion',
			content: {
				sections: [
					{ id: 's1', title: 'Shipping', items: [text('acc-text', '<p>Three days</p>')] },
					{ id: 's2', title: '', items: [] },
				],
			},
		},
	];
	const rows = translationBlockRows(blocks, t);

	it('lists every distinct item text once, grouped under its Block', () => {
		expect(rows.map((row) => [row.group ?? '', row.label, row.sourceText])).toEqual([
			['listBlock(1)', 'repeatedText(listItem(1),1)', 'Free shipping'],
			['listBlock(1)', 'listItem(2)', 'Returns'],
			['tableBlock(1)', 'tableHeader(1)', 'Product'],
			['tableBlock(1)', 'tableHeader(2)', 'Price'],
			['tableBlock(1)', 'tableCell(1,1)', 'Shirt'],
			['tableBlock(1)', 'tableCell(1,2)', '49'],
			['tableBlock(1)', 'tableFooter(1)', 'Total'],
			['tableBlock(1)', 'tableCaption()', 'Order'],
			['menuBlock(1)', 'menuLink(1)', 'Shop'],
			['', 'accordionSectionTitle(1,1)', 'Shipping'],
			['', 'accordionSectionPrefix(1,1) > textBlock(1)', '<p>Three days</p>'],
		]);
	});

	it('addresses each row where the merge reads it', () => {
		const overlay = overlayFor(rows, (row) => `de:${row.sourceText}`);
		const merged = blocks.map((block) => mergeTranslationIntoItem(block as BlockLikeItem, overlay));
		expect(merged[0]!.content['items']).toEqual([
			'de:Free shipping',
			'de:Returns',
			'de:Free shipping',
		]);
		expect(merged[1]!.content['rows']).toEqual([['de:Shirt', 'de:49']]);
		expect(merged[1]!.content['footerRow']).toEqual(['de:Total', '']);
		expect(merged[2]!.content['items']).toEqual([{ label: 'de:Shop', url: 'https://owlat.com' }]);
		const sections = merged[3]!.content['sections'] as { title: string; items: BlockLikeItem[] }[];
		expect(sections.map((section) => section.title)).toEqual(['de:Shipping', '']);
		expect(sections[0]!.items[0]!.content['html']).toBe('de:<p>Three days</p>');
	});
});

describe('translationProgress', () => {
	it('counts the rows that hold text in a language', () => {
		const rows = [
			{ id: 'a', fieldType: 'subject', sourceText: 'S', label: '' },
			{ id: 'b', fieldType: 'itemText', sourceText: 'I', label: '' },
			{ id: 'c', fieldType: 'itemText', sourceText: 'J', label: '' },
		] as const;
		const values: Record<string, string> = { a: 'B', b: 'Eintrag' };
		expect(translationProgress(rows, (row) => values[row.id] ?? '')).toEqual({ done: 2, total: 3 });
	});
});

describe('sharedContentKinds', () => {
	it('names the content every language shares, at any depth', () => {
		expect(
			sharedContentKinds([
				{ id: 'b', type: 'button', content: { text: 'Go', url: 'https://owlat.com' } },
				{
					id: 'c',
					type: 'container',
					content: { items: [{ id: 'i', type: 'image', content: { src: 'a.png', alt: 'A' } }] },
				},
				{ id: 'r', type: 'rawHtml', content: { html: '<p>x</p>' } },
			])
		).toEqual(['links', 'images', 'rawHtml']);
		expect(sharedContentKinds([text('t', '<p>Only text</p>')])).toEqual([]);
	});
});
