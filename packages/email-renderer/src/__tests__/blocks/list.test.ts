import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '../../renderer';
import type { EditorBlock, ListBlockContent } from '@owlat/shared';

describe('List Block', () => {
	const makeListBlock = (content: Partial<ListBlockContent>): EditorBlock => ({
		id: 'list-1',
		type: 'list',
		content: {
			items: ['First item', 'Second item', 'Third item'],
			listType: 'bullet',
			...content,
		} as ListBlockContent,
	});

	it('should render bullet list with table-based layout', () => {
		const html = renderEmailHtml([makeListBlock({})], { inlineCss: false });
		expect(html).toContain('First item');
		expect(html).toContain('Second item');
		expect(html).toContain('&#8226;'); // bullet character
	});

	it('should render numbered list', () => {
		const html = renderEmailHtml([makeListBlock({ listType: 'numbered' })], { inlineCss: false });
		expect(html).toContain('1.');
		expect(html).toContain('2.');
		expect(html).toContain('3.');
	});

	it('should render check list', () => {
		const html = renderEmailHtml([makeListBlock({ listType: 'check' })], { inlineCss: false });
		expect(html).toContain('&#10003;'); // checkmark
	});

	it('should render icon list with custom image', () => {
		const html = renderEmailHtml([makeListBlock({
			listType: 'icon',
			iconUrl: 'https://example.com/star.png',
		})], { inlineCss: false });
		expect(html).toContain('star.png');
	});

	it('should apply custom text color', () => {
		const html = renderEmailHtml([makeListBlock({ textColor: '#ff0000' })], { inlineCss: false });
		expect(html).toContain('color:#ff0000');
	});

	it('should apply custom bullet color', () => {
		const html = renderEmailHtml([makeListBlock({ bulletColor: '#00ff00' })], { inlineCss: false });
		expect(html).toContain('color:#00ff00');
	});

	it('should return empty for no items', () => {
		const html = renderEmailHtml([makeListBlock({ items: [] })], { inlineCss: false });
		expect(html).not.toContain('&#8226;');
	});
});
