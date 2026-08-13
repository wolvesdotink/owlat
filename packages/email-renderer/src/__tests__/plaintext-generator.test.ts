/**
 * text/plain generator — the block-document → text rendering that backs the
 * multipart alternative and the builder's "Plain text" view.
 *
 * Covers the four things a text-only reader needs out of a designed email:
 * heading structure, links that keep their destination, list/CTA shapes, and
 * NO decorative noise.
 */

import { describe, it, expect } from 'vitest';
import { renderPlainText, resolvePlainText, hasPlainTextOverride } from '../plaintext';
import type {
	EditorBlock,
	ButtonBlockContent,
	ImageBlockContent,
	ListBlockContent,
	TextBlockContent,
} from '@owlat/shared';

const text = (html: string, blockType: TextBlockContent['blockType'] = 'paragraph'): EditorBlock =>
	({
		id: `t-${blockType}-${html.length}`,
		type: 'text',
		content: { html, blockType, fontSize: 16, textColor: '#333' } as TextBlockContent,
	}) as EditorBlock;

describe('renderPlainText — headings', () => {
	it('underlines an h1 with = and an h2 with -', () => {
		const out = renderPlainText([text('Welcome', 'h1'), text('Details', 'h2')]);
		expect(out).toBe('Welcome\n=======\n\nDetails\n-------');
	});

	it('leaves h3 and paragraphs unruled', () => {
		const out = renderPlainText([text('Small heading', 'h3'), text('Body copy')]);
		expect(out).toBe('Small heading\n\nBody copy');
	});

	it('sizes the rule to the longest line of a wrapped heading', () => {
		const out = renderPlainText([text('One<br>Three', 'h1')]);
		expect(out).toBe('One\nThree\n=====');
	});

	it('emits no rule for an empty heading', () => {
		expect(renderPlainText([text('', 'h1')])).toBe('');
	});
});

describe('renderPlainText — links', () => {
	it('renders an inline link as "label (url)"', () => {
		const out = renderPlainText([
			text('Read the <a href="https://owlat.dev/docs">documentation</a> first.'),
		]);
		expect(out).toBe('Read the documentation (https://owlat.dev/docs) first.');
	});

	it('keeps the visible text of a link wrapping inline markup', () => {
		const out = renderPlainText([
			text('<a href="https://owlat.dev"><strong>Owlat</strong></a> ships'),
		]);
		expect(out).toBe('Owlat (https://owlat.dev) ships');
	});

	it('handles single-quoted hrefs', () => {
		const out = renderPlainText([text("<a href='https://owlat.dev'>Site</a>")]);
		expect(out).toBe('Site (https://owlat.dev)');
	});

	it('expands every link independently when two share a label', () => {
		const out = renderPlainText([
			text('<a href="https://a.example">Open</a> or <a href="https://b.example">Open</a>'),
		]);
		expect(out).toBe('Open (https://a.example) or Open (https://b.example)');
	});

	it('collapses a link whose label already is the url', () => {
		const out = renderPlainText([text('<a href="https://owlat.dev">https://owlat.dev</a>')]);
		expect(out).toBe('https://owlat.dev');
	});

	it('collapses a mailto link labelled with its own address', () => {
		const out = renderPlainText([text('<a href="mailto:hi@owlat.dev">hi@owlat.dev</a>')]);
		expect(out).toBe('hi@owlat.dev');
	});

	it('decodes numeric entities left by the rich-text editor', () => {
		expect(renderPlainText([text('It&#8217;s here &#x2014; now')])).toBe('It’s here — now');
	});
});

describe('renderPlainText — lists and CTAs', () => {
	it('renders a button as its label plus the destination url', () => {
		const blocks: EditorBlock[] = [
			{
				id: 'b1',
				type: 'button',
				content: { text: 'Start free', url: 'https://owlat.dev/signup' } as ButtonBlockContent,
			} as EditorBlock,
		];
		expect(renderPlainText(blocks)).toBe('[Start free] https://owlat.dev/signup');
	});

	it('renders bullet and numbered lists with their markers', () => {
		const blocks: EditorBlock[] = [
			{
				id: 'l1',
				type: 'list',
				content: { items: ['Alpha', 'Beta'], listType: 'bullet' } as ListBlockContent,
			} as EditorBlock,
			{
				id: 'l2',
				type: 'list',
				content: { items: ['First'], listType: 'numbered' } as ListBlockContent,
			} as EditorBlock,
		];
		expect(renderPlainText(blocks)).toBe('- Alpha\n- Beta\n\n1. First');
	});
});

describe('renderPlainText — decorative blocks', () => {
	const image = (content: Partial<ImageBlockContent>, id: string): EditorBlock =>
		({
			id,
			type: 'image',
			content: { src: 'x.png', ...content } as ImageBlockContent,
		}) as EditorBlock;

	it('skips a spacer and an image the author marked decorative', () => {
		const blocks: EditorBlock[] = [
			text('Above'),
			{ id: 's1', type: 'spacer', content: { height: 32 } } as unknown as EditorBlock,
			image({ decorative: true }, 'i1'),
			text('Below'),
		];
		expect(renderPlainText(blocks)).toBe('Above\n\nBelow');
	});

	it('keeps a content image whose alt text is merely missing', () => {
		// Missing alt is an authoring gap the analyzer already flags — dropping the
		// image would hide from the text part that anything was there at all.
		expect(renderPlainText([image({}, 'i1')])).toBe('[Image]');
	});

	it('keeps a decorative image that links somewhere', () => {
		expect(renderPlainText([image({ decorative: true, linkUrl: 'https://owlat.dev' }, 'i1')])).toBe(
			'[Image] (https://owlat.dev)'
		);
	});

	it('keeps an image that carries alt text or a link', () => {
		const out = renderPlainText([
			image({ alt: 'Product shot' }, 'i1'),
			image({ linkUrl: 'https://owlat.dev/tour' }, 'i2'),
		]);
		expect(out).toBe('[Image: Product shot]\n\n[Image] (https://owlat.dev/tour)');
	});

	it('never leaves a blank-line hole where a skipped block was', () => {
		const blocks: EditorBlock[] = [
			text('One'),
			{ id: 's1', type: 'spacer', content: { height: 8 } } as unknown as EditorBlock,
			{ id: 's2', type: 'spacer', content: { height: 8 } } as unknown as EditorBlock,
			text('Two'),
		];
		expect(renderPlainText(blocks)).not.toMatch(/\n\n\n/);
	});
});

describe('renderPlainText — document shape', () => {
	it('is a pure function of the blocks — the hidden preheader stays out of it', () => {
		// The preheader is an inbox-preview device on the HTML part; repeating it
		// as the first line of the text part would read as duplicated copy, and
		// would make the builder's Text view differ from what is stored on save.
		const out = renderPlainText([text('Body')], { preheaderText: 'Your July report' });
		expect(out).toBe('Body');
	});

	it('recurses into columns and containers', () => {
		const blocks: EditorBlock[] = [
			{
				id: 'c1',
				type: 'columns',
				content: {
					columns: [
						[{ id: 'ci1', type: 'text', content: { html: 'Left', blockType: 'paragraph' } }],
						[{ id: 'ci2', type: 'text', content: { html: 'Right', blockType: 'paragraph' } }],
					],
				},
			} as unknown as EditorBlock,
		];
		const out = renderPlainText(blocks);
		expect(out).toContain('Left');
		expect(out).toContain('Right');
	});

	it('returns an empty string for an empty document', () => {
		expect(renderPlainText([])).toBe('');
	});
});

describe('resolvePlainText', () => {
	const blocks = [text('Generated body')];

	it('prefers a manual override', () => {
		expect(resolvePlainText(blocks, 'Hand-written body')).toBe('Hand-written body');
	});

	it('falls back to the generated body for an absent or blank override', () => {
		expect(resolvePlainText(blocks, undefined)).toBe('Generated body');
		expect(resolvePlainText(blocks, '   \n\t ')).toBe('Generated body');
		expect(resolvePlainText(blocks, null)).toBe('Generated body');
	});

	it('canonicalizes the line endings and the document ends of an override', () => {
		expect(resolvePlainText(blocks, '\r\nLine one\r\nLine two\r\n\r\n\r\n')).toBe(
			'Line one\nLine two'
		);
	});

	it('ships the rest of an override exactly as the author wrote it', () => {
		// The generated branch collapses blank-line runs to close the holes its own
		// decorative blocks leave. In a hand-written body that spacing is the
		// author's — a stanza break, an ASCII rule, an indented signature.
		const written = 'Header\n\n\n---\n\n\n  Regards,\n  Marcel';
		expect(resolvePlainText(blocks, written)).toBe(written);
	});

	it('reports whether an override is meaningful', () => {
		expect(hasPlainTextOverride('x')).toBe(true);
		expect(hasPlainTextOverride('')).toBe(false);
		expect(hasPlainTextOverride(undefined)).toBe(false);
	});
});
