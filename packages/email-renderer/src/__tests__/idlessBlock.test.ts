import { describe, expect, it } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { renderEmailHtml } from '../renderer';

// A Block without an id (#1432). Legacy saved Blocks were stored without one;
// the readers now give every Block an id, but a direct caller can still pass
// one in, and the render must not fail on it.

const idless = (type: string, content: Record<string, unknown>): EditorBlock =>
	({ type, content }) as unknown as EditorBlock;

describe('renderEmailHtml with a Block that has no id', () => {
	it('renders the Block and leaves out its data-block-id attribute', () => {
		const html = renderEmailHtml([
			idless('button', { text: 'Read more', url: 'https://example.com', align: 'center' }),
			{ id: 'kept', type: 'text', content: { html: '<p>Next</p>' } } as EditorBlock,
		]);

		expect(html).toContain('Read more');
		expect(html).toContain('Next');
		expect(html).toContain('data-block-id="kept"');
		expect(html).not.toContain('data-block-id="undefined"');
		expect(html.match(/data-block-id=/g)).toHaveLength(1);
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
});
