import { describe, expect, it } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { renderAmpEmail } from '../amp';
import { renderBlockFragment, renderEmailHtml } from '../renderer';

// A Block without an id (#1432). Legacy saved Blocks were stored without one;
// the readers give every Block an id, but a direct caller can still pass one
// in. The renderer fills the id at its entry points, so no block module (data
// attribute, responsive CSS selector, link tracking, accordion toggle) meets
// an undefined id and fails the whole render.

const idless = (type: string, content: Record<string, unknown>): EditorBlock =>
	({ type, content }) as unknown as EditorBlock;

describe('renderEmailHtml with a Block that has no id', () => {
	it('renders the Block under a filled id and keeps the ids it was given', () => {
		const html = renderEmailHtml([
			idless('button', { text: 'Read more', url: 'https://example.com', align: 'center' }),
			{ id: 'kept', type: 'text', content: { html: '<p>Next</p>' } } as EditorBlock,
		]);

		expect(html).toContain('Read more');
		expect(html).toContain('Next');
		expect(html).toContain('data-block-id="kept"');
		expect(html).toContain('data-block-id="block-1"');
		expect(html).not.toContain('undefined');
	});

	it('renders an id-less text Block with a mobile font size (responsive CSS)', () => {
		const html = renderEmailHtml([idless('text', { html: '<p>Test</p>', mobileFontSize: 14 })]);
		expect(html).toContain('Test');
		expect(html).toContain('[data-block-id="block-1"] div{font-size:14px!important}');
	});

	it('renders an id-less accordion and its id-less sections', () => {
		const html = renderEmailHtml([
			idless('accordion', {
				sections: [
					{ title: 'First', items: [idless('text', { html: '<p>One</p>' })] },
					{ title: 'Second', items: [] },
				],
			}),
		]);
		expect(html).toContain('First');
		expect(html).toContain('One');
		expect(html).not.toContain('undefined');
		// Each section gets its own toggle, so one header cannot open the other.
		expect(html).toContain('owlat-accordion-block-1"');
		expect(html).toContain('owlat-acc-section-2"');
		expect(html).toContain('owlat-acc-section-3"');
	});

	it('renders an id-less Block nested in a container', () => {
		const html = renderEmailHtml([
			{
				id: 'box',
				type: 'container',
				content: { items: [idless('text', { html: '<p>Inside</p>' })] },
			} as unknown as EditorBlock,
		]);
		expect(html).toContain('Inside');
	});

	it('does not mutate the caller’s Blocks', () => {
		const block = idless('text', { html: '<p>Mine</p>' });
		renderEmailHtml([block]);
		expect(block).not.toHaveProperty('id');
	});
});

describe('other renderer entry points with a Block that has no id', () => {
	it('renderBlockFragment renders an id-less text Block with a mobile font size', () => {
		const html = renderBlockFragment(idless('text', { html: '<p>Frag</p>', mobileFontSize: 12 }));
		expect(html).toContain('Frag');
		expect(html).not.toContain('undefined');
	});

	it('renderAmpEmail renders an id-less accordion', () => {
		const html = renderAmpEmail([idless('accordion', { sections: [{ title: 'Amp', items: [] }] })]);
		expect(html).toContain('Amp');
	});
});
