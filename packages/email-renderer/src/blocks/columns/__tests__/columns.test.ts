import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '../../../renderer';
import type { EditorBlock, ColumnsBlockContent, TextBlockContent } from '@owlat/shared';

describe('Enhanced Columns Block', () => {
	const makeColumnsBlock = (content: Partial<ColumnsBlockContent>): EditorBlock => ({
		id: 'cols-1',
		type: 'columns',
		content: {
			columnCount: 2,
			ratio: 'equal',
			mobileStacking: true,
			columns: [
				[{
					id: 'col-item-1',
					type: 'text',
					content: { html: '<p>Left column</p>', blockType: 'paragraph', fontSize: 16, textColor: '#333' } as TextBlockContent,
				}],
				[{
					id: 'col-item-2',
					type: 'text',
					content: { html: '<p>Right column</p>', blockType: 'paragraph', fontSize: 16, textColor: '#333' } as TextBlockContent,
				}],
			],
			...content,
		} as ColumnsBlockContent,
	});

	it('should render reverse mobile stacking with CSS classes', () => {
		const html = renderEmailHtml([makeColumnsBlock({ mobileStackOrder: 'reverse' })], { inlineCss: false });
		expect(html).toContain('owlat-col-rev-');
	});

	it('should render normal stacking without reverse classes', () => {
		const html = renderEmailHtml([makeColumnsBlock({ mobileStackOrder: 'normal' })], { inlineCss: false });
		expect(html).not.toContain('owlat-col-rev-');
	});

	it('should respect per-column stackOnMobile override', () => {
		const html = renderEmailHtml([makeColumnsBlock({
			columnStyles: [
				{ stackOnMobile: false },
				{ stackOnMobile: true },
			],
		})], { inlineCss: false });
		// First column should NOT have owlat-col class (non-stacking)
		// Second column should have owlat-col class (stacking)
		const matches = html.match(/class="owlat-col"/g) || [];
		expect(matches.length).toBe(1); // Only second column stacks
	});

	it('should render non-stacking columns with table-cell display', () => {
		const html = renderEmailHtml([makeColumnsBlock({ mobileStacking: false })], { inlineCss: false });
		expect(html).toContain('display:table-cell');
	});
});
