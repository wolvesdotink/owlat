import { describe, it, expect } from 'vitest';
import { validateBlocks } from '../validator';
import type { EditorBlock, CarouselBlockContent, ListBlockContent, ProgressBarBlockContent, TextBlockContent, ButtonBlockContent, TableBlockContent } from '@owlat/shared';

describe('Validator - New Block Types', () => {
	it('should validate empty carousel', () => {
		const blocks: EditorBlock[] = [{
			id: 'c1', type: 'carousel',
			content: { images: [] } as unknown as CarouselBlockContent,
		}];
		const result = validateBlocks(blocks);
		expect(result.issues.some((i) => i.code === 'CAROUSEL_NO_IMAGES')).toBe(true);
	});

	it('should warn on single-image carousel', () => {
		const blocks: EditorBlock[] = [{
			id: 'c1', type: 'carousel',
			content: { images: [{ src: 'a.jpg', alt: 'A' }] } as CarouselBlockContent,
		}];
		const result = validateBlocks(blocks);
		expect(result.issues.some((i) => i.code === 'CAROUSEL_SINGLE_IMAGE')).toBe(true);
	});

	it('should validate carousel image without src', () => {
		const blocks: EditorBlock[] = [{
			id: 'c1', type: 'carousel',
			content: { images: [{ src: '', alt: 'A' }] } as CarouselBlockContent,
		}];
		const result = validateBlocks(blocks);
		expect(result.issues.some((i) => i.code === 'CAROUSEL_IMAGE_NO_SRC')).toBe(true);
	});

	it('should validate empty list', () => {
		const blocks: EditorBlock[] = [{
			id: 'l1', type: 'list',
			content: { items: [], listType: 'bullet' } as ListBlockContent,
		}];
		const result = validateBlocks(blocks);
		expect(result.issues.some((i) => i.code === 'LIST_EMPTY')).toBe(true);
	});

	it('should warn on icon list without URL', () => {
		const blocks: EditorBlock[] = [{
			id: 'l1', type: 'list',
			content: { items: ['A'], listType: 'icon' } as ListBlockContent,
		}];
		const result = validateBlocks(blocks);
		expect(result.issues.some((i) => i.code === 'LIST_ICON_NO_URL')).toBe(true);
	});

	it('should validate progress bar out of range', () => {
		const blocks: EditorBlock[] = [{
			id: 'p1', type: 'progressBar',
			content: { value: 150, barColor: '#000', trackColor: '#fff', height: 20 } as ProgressBarBlockContent,
		}];
		const result = validateBlocks(blocks);
		expect(result.issues.some((i) => i.code === 'PROGRESS_OUT_OF_RANGE')).toBe(true);
	});

});

describe('Validator - Accessibility Audit', () => {
	it('should flag vague link text', () => {
		const blocks: EditorBlock[] = [{
			id: 't1', type: 'text',
			content: { html: '<a href="/page">click here</a>', blockType: 'paragraph', fontSize: 16, textColor: '#333' } as TextBlockContent,
		}];
		const result = validateBlocks(blocks, { accessibilityAudit: true });
		expect(result.issues.some((i) => i.code === 'A11Y_VAGUE_LINK_TEXT')).toBe(true);
	});

	it('should not flag descriptive link text', () => {
		const blocks: EditorBlock[] = [{
			id: 't1', type: 'text',
			content: { html: '<a href="/page">View your order details</a>', blockType: 'paragraph', fontSize: 16, textColor: '#333' } as TextBlockContent,
		}];
		const result = validateBlocks(blocks, { accessibilityAudit: true });
		expect(result.issues.some((i) => i.code === 'A11Y_VAGUE_LINK_TEXT')).toBe(false);
	});

	it('should flag low contrast buttons', () => {
		const blocks: EditorBlock[] = [{
			id: 'b1', type: 'button',
			content: {
				text: 'Buy Now', url: 'https://example.com',
				backgroundColor: '#ffffff', textColor: '#cccccc',
				align: 'center', borderRadius: 4, paddingX: 20, paddingY: 10,
			} as ButtonBlockContent,
		}];
		const result = validateBlocks(blocks, { accessibilityAudit: true });
		expect(result.issues.some((i) => i.code === 'A11Y_LOW_CONTRAST')).toBe(true);
	});

	it('should not flag high contrast buttons', () => {
		const blocks: EditorBlock[] = [{
			id: 'b1', type: 'button',
			content: {
				text: 'Buy Now', url: 'https://example.com',
				backgroundColor: '#000000', textColor: '#ffffff',
				align: 'center', borderRadius: 4, paddingX: 20, paddingY: 10,
			} as ButtonBlockContent,
		}];
		const result = validateBlocks(blocks, { accessibilityAudit: true });
		expect(result.issues.some((i) => i.code === 'A11Y_LOW_CONTRAST')).toBe(false);
	});

	it('should flag heading level skips', () => {
		const blocks: EditorBlock[] = [
			{
				id: 't1', type: 'text',
				content: { html: '<h1>Title</h1>', blockType: 'h1', fontSize: 32, textColor: '#333' } as TextBlockContent,
			},
			{
				id: 't2', type: 'text',
				content: { html: '<h3>Subtitle</h3>', blockType: 'h3', fontSize: 18, textColor: '#333' } as TextBlockContent,
			},
		];
		const result = validateBlocks(blocks, { accessibilityAudit: true });
		expect(result.issues.some((i) => i.code === 'A11Y_HEADING_SKIP')).toBe(true);
	});

	it('should flag missing table caption', () => {
		const blocks: EditorBlock[] = [{
			id: 'tbl1', type: 'table',
			content: {
				headers: ['A'], rows: [['B']],
				headerBackgroundColor: '#f5f5f5', headerTextColor: '#333',
				borderColor: '#e0e0e0', striped: false, stripeColor: '#fafafa',
				cellPadding: 8, textAlign: 'left',
			} as TableBlockContent,
		}];
		const result = validateBlocks(blocks, { accessibilityAudit: true });
		expect(result.issues.some((i) => i.code === 'A11Y_TABLE_NO_CAPTION')).toBe(true);
	});

	it('should flag carousel images without alt text', () => {
		const blocks: EditorBlock[] = [{
			id: 'c1', type: 'carousel',
			content: { images: [{ src: 'a.jpg', alt: '' }, { src: 'b.jpg', alt: 'B' }] } as CarouselBlockContent,
		}];
		const result = validateBlocks(blocks, { accessibilityAudit: true });
		expect(result.issues.some((i) => i.code === 'A11Y_CAROUSEL_IMAGE_NO_ALT')).toBe(true);
	});
});
