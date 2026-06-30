import { describe, it, expect } from 'vitest';
import { renderPlainText } from '../plaintext';
import type { EditorBlock, CarouselBlockContent, ListBlockContent, ProgressBarBlockContent, TableBlockContent } from '@owlat/shared';

describe('Plain Text - New Block Types', () => {
	it('should render carousel as image list', () => {
		const blocks: EditorBlock[] = [{
			id: 'c1', type: 'carousel',
			content: {
				images: [
					{ src: 'a.jpg', alt: 'Photo A', linkUrl: 'https://example.com/a' },
					{ src: 'b.jpg', alt: 'Photo B' },
				],
			} as CarouselBlockContent,
		}];
		const text = renderPlainText(blocks);
		expect(text).toContain('[Image 1: Photo A] (https://example.com/a)');
		expect(text).toContain('[Image 2: Photo B]');
	});

	it('should render bullet list', () => {
		const blocks: EditorBlock[] = [{
			id: 'l1', type: 'list',
			content: { items: ['First', 'Second'], listType: 'bullet' } as ListBlockContent,
		}];
		const text = renderPlainText(blocks);
		expect(text).toContain('- First');
		expect(text).toContain('- Second');
	});

	it('should render numbered list', () => {
		const blocks: EditorBlock[] = [{
			id: 'l1', type: 'list',
			content: { items: ['First', 'Second'], listType: 'numbered' } as ListBlockContent,
		}];
		const text = renderPlainText(blocks);
		expect(text).toContain('1. First');
		expect(text).toContain('2. Second');
	});

	it('should render check list', () => {
		const blocks: EditorBlock[] = [{
			id: 'l1', type: 'list',
			content: { items: ['Done task'], listType: 'check' } as ListBlockContent,
		}];
		const text = renderPlainText(blocks);
		expect(text).toContain('[x] Done task');
	});

	it('should render progress bar as percentage', () => {
		const blocks: EditorBlock[] = [{
			id: 'p1', type: 'progressBar',
			content: { value: 75, barColor: '#000', trackColor: '#fff', height: 20 } as ProgressBarBlockContent,
		}];
		const text = renderPlainText(blocks);
		expect(text).toContain('[Progress: 75%]');
	});

	it('should render enhanced table with rich cells', () => {
		const blocks: EditorBlock[] = [{
			id: 'tbl1', type: 'table',
			content: {
				headers: ['A', 'B'],
				rows: [],
				cells: [
					[{ content: '<b>Bold</b>' }, { content: 'Normal' }],
				],
				captionText: 'Test Table',
				headerBackgroundColor: '#f5f5f5', headerTextColor: '#333',
				borderColor: '#e0e0e0', striped: false, stripeColor: '#fafafa',
				cellPadding: 8, textAlign: 'left',
			} as TableBlockContent,
		}];
		const text = renderPlainText(blocks);
		expect(text).toContain('Test Table');
		expect(text).toContain('Bold | Normal');
	});

	it('should render table with footer row', () => {
		const blocks: EditorBlock[] = [{
			id: 'tbl1', type: 'table',
			content: {
				headers: ['Item', 'Price'],
				rows: [['Widget', '$10']],
				footerRow: ['Total', '$10'],
				headerBackgroundColor: '#f5f5f5', headerTextColor: '#333',
				borderColor: '#e0e0e0', striped: false, stripeColor: '#fafafa',
				cellPadding: 8, textAlign: 'left',
			} as TableBlockContent,
		}];
		const text = renderPlainText(blocks);
		expect(text).toContain('Total | $10');
	});
});

describe('Plain Text - configurable baseWidth', () => {
	it('should render with custom baseWidth', () => {
		const blocks: EditorBlock[] = [{
			id: 't1', type: 'text',
			content: { html: 'Hello', blockType: 'paragraph', fontSize: 16, textColor: '#333' },
		} as EditorBlock];
		// This should not throw
		const text = renderPlainText(blocks, { baseWidth: 700 });
		expect(text).toContain('Hello');
	});
});
