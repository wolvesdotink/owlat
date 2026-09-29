import { describe, it, expect } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { DEFAULT_THEME, renderEmailHtml } from '../../renderer';
import { renderAmpEmail } from '../../amp';
import { moduleFor, registeredBlockTypes } from '../../blocks/_registry';
import { px } from '../../helpers/padding';

/**
 * Numeric style fields (padding, margin, sizes, widths) are interpolated into
 * `style="..."` and sizing attributes. Stored content is JSON, so a field typed
 * `number` can arrive as any value; the renderer coerces each one to a finite
 * number before it reaches the markup. String style fields (colours, keyword
 * enums such as alignment or border style) are escaped the same way colours
 * already were.
 */

const MARKER = 'data-probe';
const BAD = `0" ${MARKER}="1`;
/** What an unescaped string field would leave in the markup. */
const RAW_BREAKOUT = `" ${MARKER}="`;

const NUMERIC_KEYS = [
	'paddingTop',
	'paddingRight',
	'paddingBottom',
	'paddingLeft',
	'marginTop',
	'marginRight',
	'marginBottom',
	'marginLeft',
	'borderWidth',
	'borderRadius',
	'buttonBorderWidth',
	'bulletSize',
	'cellPadding',
	'columnGap',
	'fontSize',
	'fontWeight',
	'headerFontSize',
	'height',
	'iconSize',
	'iconSpacing',
	'iconWidth',
	'itemSpacing',
	'labelFontSize',
	'letterSpacing',
	'lineHeight',
	'maxValue',
	'maxWidth',
	'mobileFontSize',
	'paddingX',
	'paddingY',
	'playButtonSize',
	'thickness',
	'thumbnailWidth',
	'value',
	'width',
] as const;

const poison = (content: Record<string, unknown>): Record<string, unknown> => {
	const out: Record<string, unknown> = { ...content };
	for (const key of NUMERIC_KEYS) out[key] = BAD;
	return out;
};

const poisonedStyle = Object.fromEntries(
	['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderWidth', 'borderRadius'].map(
		(k) => [k, BAD]
	)
);

/** Default content for a block type with every numeric field replaced. */
const poisonedBlock = (type: string, id: string): EditorBlock => {
	const mod = moduleFor(type as EditorBlock['type']);
	const base = (mod?.createDefault?.(DEFAULT_THEME) ?? {}) as Record<string, unknown>;
	const content = poison(base);
	const child = { id: `${id}-c`, type: 'text', content: poison({ html: '<p>x</p>' }) };
	switch (type) {
		case 'container':
		case 'hero':
			content['items'] = [child];
			break;
		case 'columns':
			content['columnCount'] = 2;
			content['columns'] = [[child], [child]];
			content['columnStyles'] = [{ ...poisonedStyle, borderStyle: 'solid' }, poisonedStyle];
			break;
		case 'table':
			content['headers'] = ['a', 'b'];
			content['rows'] = [['1', '2']];
			content['cells'] = [
				[{ content: 'x', colSpan: BAD, rowSpan: BAD, fontWeight: BAD }, { content: 'y' }],
			];
			break;
		case 'list':
			content['items'] = ['one', 'two'];
			break;
		case 'image':
			content['src'] = 'https://example.com/a.png';
			break;
		case 'video':
			content['thumbnailUrl'] = 'https://example.com/a.png';
			content['videoUrl'] = 'https://example.com/v';
			break;
		case 'social':
			content['links'] = [
				{ platform: 'twitter', url: 'https://example.com/x', enabled: true },
				{
					platform: 'facebook',
					url: 'https://example.com/f',
					enabled: true,
					iconUrl: 'https://example.com/f.png',
				},
			];
			break;
		case 'carousel':
			content['images'] = [
				{ src: 'https://example.com/1.png', alt: '', thumbnailSrc: 'https://example.com/t1.png' },
				{ src: 'https://example.com/2.png', alt: '' },
			];
			break;
		case 'accordion':
			content['sections'] = [{ id: 's1', title: 'One', items: [child] }];
			break;
		case 'menu':
			content['items'] = [
				{ label: 'A', url: 'https://example.com/a' },
				{ label: 'B', url: 'https://example.com/b' },
			];
			break;
		case 'progressBar':
			content['showLabel'] = true;
			break;
		default:
			break;
	}
	return { id, type, content } as unknown as EditorBlock;
};

const blockTypes = registeredBlockTypes().filter((t) => moduleFor(t as EditorBlock['type']));

describe('px', () => {
	it('keeps finite numbers and numeric strings', () => {
		expect(px(12, 0)).toBe(12);
		expect(px(-4, 0)).toBe(-4);
		expect(px('8', 0)).toBe(8);
		expect(px(' 2.5 ', 0)).toBe(2.5);
	});

	it('falls back for anything that is not a finite number', () => {
		expect(px(undefined, 16)).toBe(16);
		expect(px(null, 16)).toBe(16);
		expect(px('', 16)).toBe(16);
		expect(px(BAD, 16)).toBe(16);
		expect(px(Number.NaN, 16)).toBe(16);
		expect(px(Number.POSITIVE_INFINITY, 16)).toBe(16);
		expect(px(true, 16)).toBe(16);
		expect(px({}, 16)).toBe(16);
		expect(px('1e400', 16)).toBe(16);
	});
});

describe('numeric style fields are coerced before interpolation', () => {
	it.each(blockTypes)('%s at root placement', (type) => {
		const html = renderEmailHtml([poisonedBlock(type, 'b1')], { inlineCss: false });
		expect(html).not.toContain(MARKER);
	});

	it.each(blockTypes)('%s inside a container', (type) => {
		const container = {
			id: 'wrap',
			type: 'container',
			content: poison({ items: [poisonedBlock(type, 'b1')] }),
		} as unknown as EditorBlock;
		const html = renderEmailHtml([container], { inlineCss: false });
		expect(html).not.toContain(MARKER);
	});

	it.each(blockTypes)('%s in the AMP output', (type) => {
		const html = renderAmpEmail([poisonedBlock(type, 'b1')]);
		expect(html).not.toContain(MARKER);
	});

	it('uses the default padding when paddingTop is not a number', () => {
		const block = {
			id: 't',
			type: 'text',
			content: { html: '<p>x</p>', blockType: 'paragraph', fontSize: 16, paddingTop: BAD },
		} as unknown as EditorBlock;
		const html = renderEmailHtml([block], { inlineCss: false });
		expect(html).toContain('padding:16px 24px 16px 24px');
	});

	it('coerces the theme base width and breakpoint', () => {
		const html = renderEmailHtml([poisonedBlock('text', 't')], {
			inlineCss: false,
			baseWidth: BAD as unknown as number,
			breakpoint: BAD as unknown as number,
		});
		expect(html).not.toContain(MARKER);
	});
});

const STRING_STYLE_KEYS = [
	'align',
	'backgroundColor',
	'backgroundPosition',
	'backgroundSize',
	'barColor',
	'blockBackgroundColor',
	'borderColor',
	'borderStyle',
	'bulletColor',
	'buttonBorderColor',
	'buttonBorderStyle',
	'color',
	'contentBackgroundColor',
	'cssClass',
	'darkBackgroundColor',
	'darkTextColor',
	'fontFamily',
	'headerBackgroundColor',
	'headerTextColor',
	'iconColor',
	'iconInactiveColor',
	'labelColor',
	'overlayColor',
	'playButtonColor',
	'sectionBorderColor',
	'separatorColor',
	'stripeColor',
	'style',
	'target',
	'textAlign',
	'textColor',
	'textDecoration',
	'textTransform',
	'trackColor',
	'verticalAlign',
] as const;

describe('string style fields are escaped before interpolation', () => {
	const withStrings = (type: string): EditorBlock => {
		const block = poisonedBlock(type, 'b1');
		// Keep numbers valid so every optional branch that depends on them renders.
		const mod = moduleFor(type as EditorBlock['type']);
		const base = (mod?.createDefault?.(DEFAULT_THEME) ?? {}) as Record<string, unknown>;
		const content: Record<string, unknown> = { ...block.content, ...base };
		for (const key of NUMERIC_KEYS) {
			if (typeof content[key] !== 'number') delete content[key];
		}
		for (const key of STRING_STYLE_KEYS) content[key] = BAD;
		content['borderWidth'] = 1;
		content['buttonBorderWidth'] = 1;
		content['borderRadius'] = 4;
		for (const key of [
			'items',
			'links',
			'images',
			'sections',
			'columns',
			'cells',
			'headers',
			'rows',
		]) {
			if (key in block.content) content[key] = (block.content as Record<string, unknown>)[key];
		}
		if (type === 'container' || type === 'hero')
			content['backgroundImage'] = 'https://example.com/bg.png';
		if (type === 'table') content['responsiveMode'] = 'stack';
		if (type === 'text') content['mobileFontSize'] = 14;
		if (type === 'columns') {
			content['columnStyles'] = [
				{
					verticalAlign: BAD,
					borderStyle: BAD,
					borderWidth: 1,
					backgroundImage: 'https://example.com/c.png',
					backgroundPosition: BAD,
					backgroundSize: BAD,
				},
			];
		}
		return { ...block, id: 'b1', content } as unknown as EditorBlock;
	};

	it.each(blockTypes)('%s in the HTML output', (type) => {
		const html = renderEmailHtml([withStrings(type)], { inlineCss: false });
		expect(html).not.toContain(RAW_BREAKOUT);
	});

	it.each(blockTypes)('%s in the AMP output', (type) => {
		const html = renderAmpEmail([withStrings(type)]);
		expect(html).not.toContain(RAW_BREAKOUT);
	});

	it('escapes theme colours and font family', () => {
		const html = renderEmailHtml([withStrings('text')], {
			inlineCss: false,
			theme: { backgroundColor: BAD, fontFamily: BAD },
		});
		expect(html).not.toContain(RAW_BREAKOUT);
	});
});
