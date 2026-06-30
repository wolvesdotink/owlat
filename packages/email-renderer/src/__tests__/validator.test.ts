import { describe, it, expect } from 'vitest';
import { validateBlocks } from '../validator';
import type { ContainerBlockContent, ContainerItem, EditorBlock } from '@owlat/shared';

describe('validateBlocks', () => {
	it('returns valid with no issues for valid blocks', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'text',
				content: { html: '<p>Hello</p>', blockType: 'paragraph', fontSize: 14, textColor: '#000' },
			},
			{
				id: '2',
				type: 'image',
				content: { src: 'https://example.com/img.jpg', alt: 'Photo', width: 100, align: 'center' },
			},
			{
				id: '3',
				type: 'text',
				content: { html: '<a href="#">Unsubscribe</a>', blockType: 'paragraph', fontSize: 14, textColor: '#999' },
			},
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(true);
		expect(result.issues).toEqual([]);
	});

	it('reports IMAGE_NO_SRC error for empty src', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'image', content: { src: '', alt: 'Photo', width: 100, align: 'center' } },
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(false);
		const issue = result.issues.find((i) => i.code === 'IMAGE_NO_SRC');
		expect(issue).toBeDefined();
		expect(issue!.severity).toBe('error');
	});

	it('reports IMAGE_NO_ALT warning for empty alt', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'image', content: { src: 'https://example.com/img.jpg', alt: '', width: 100, align: 'center' } },
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(true);
		const issue = result.issues.find((i) => i.code === 'IMAGE_NO_ALT');
		expect(issue).toBeDefined();
		expect(issue!.severity).toBe('warning');
	});

	it('reports BUTTON_NO_URL error for empty URL', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'button', content: { text: 'Click', url: '', backgroundColor: '#000', textColor: '#fff', align: 'center', borderRadius: 4, paddingX: 24, paddingY: 12 } },
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(false);
		expect(result.issues.find((i) => i.code === 'BUTTON_NO_URL')).toBeDefined();
	});

	it('reports BUTTON_NO_URL error for # URL', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'button', content: { text: 'Click', url: '#', backgroundColor: '#000', textColor: '#fff', align: 'center', borderRadius: 4, paddingX: 24, paddingY: 12 } },
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(false);
		expect(result.issues.find((i) => i.code === 'BUTTON_NO_URL')).toBeDefined();
	});

	it('reports BUTTON_NO_TEXT warning for empty text', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'button', content: { text: '', url: 'https://example.com', backgroundColor: '#000', textColor: '#fff', align: 'center', borderRadius: 4, paddingX: 24, paddingY: 12 } },
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(true);
		expect(result.issues.find((i) => i.code === 'BUTTON_NO_TEXT')).toBeDefined();
	});

	it('reports TABLE_EMPTY error when no headers and no rows', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'table',
				content: {
					headers: [],
					rows: [],
					headerBackgroundColor: '#000',
					headerTextColor: '#fff',
					borderColor: '#ccc',
					striped: false,
					stripeColor: '#f5f5f5',
					cellPadding: 8,
					textAlign: 'left',
				},
			},
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(false);
		expect(result.issues.find((i) => i.code === 'TABLE_EMPTY')).toBeDefined();
	});

	it('reports VIDEO_NO_THUMBNAIL and VIDEO_NO_URL errors', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'video',
				content: { thumbnailUrl: '', videoUrl: '', alt: 'Video', width: 100, align: 'center' },
			},
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(false);
		expect(result.issues.find((i) => i.code === 'VIDEO_NO_THUMBNAIL')).toBeDefined();
		expect(result.issues.find((i) => i.code === 'VIDEO_NO_URL')).toBeDefined();
	});

	it('reports TEXT_EMPTY warning for empty html', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'text', content: { html: '', blockType: 'paragraph', fontSize: 14, textColor: '#000' } },
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(true);
		expect(result.issues.find((i) => i.code === 'TEXT_EMPTY')).toBeDefined();
	});

	it('reports HERO_NO_BG warning when no background image', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'hero',
				content: {
					backgroundImage: '',
					backgroundPosition: 'center',
					backgroundSize: 'cover',
					height: 400,
					mode: 'fixed-height',
					verticalAlign: 'middle',
					items: [],
				},
			},
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(true);
		expect(result.issues.find((i) => i.code === 'HERO_NO_BG')).toBeDefined();
	});

	it('reports COLUMNS_ALL_EMPTY warning when all columns are empty', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'columns',
				content: {
					columnCount: 2 as const,
					ratio: 'equal',
					mobileStacking: true,
					columns: [[], []],
				},
			},
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(true);
		expect(result.issues.find((i) => i.code === 'COLUMNS_ALL_EMPTY')).toBeDefined();
	});

	it('reports CONTAINER_DEEP_NESTING warning for deeply nested containers', () => {
		const containerContent = (items: ContainerItem[]): ContainerBlockContent => ({
			items,
			maxWidth: 100, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
			paddingLinked: false, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
			borderWidth: 0, borderColor: '#000', borderStyle: 'none' as const, borderRadius: 0,
		});
		// depth 0 -> 1 -> 2 -> 3 -> 4 (triggers at depth > 3)
		const deepBlock: EditorBlock = {
			id: 'deep',
			type: 'container',
			content: containerContent([
				{ id: 'c1', type: 'container', content: containerContent([
					{ id: 'c2', type: 'container', content: containerContent([
						{ id: 'c3', type: 'container', content: containerContent([
							{ id: 'c4', type: 'container', content: containerContent([]) },
						]) },
					]) },
				]) },
			]),
		};
		const result = validateBlocks([deepBlock]);
		expect(result.issues.find((i) => i.code === 'CONTAINER_DEEP_NESTING')).toBeDefined();
	});

	it('reports EMAIL_IMAGE_ONLY warning for image-only emails', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'image', content: { src: 'https://example.com/a.jpg', alt: 'A', width: 100, align: 'center' } },
			{ id: '2', type: 'image', content: { src: 'https://example.com/b.jpg', alt: 'B', width: 100, align: 'center' } },
			{ id: '3', type: 'spacer', content: { height: 20 } },
		];
		const result = validateBlocks(blocks);
		expect(result.issues.find((i) => i.code === 'EMAIL_IMAGE_ONLY')).toBeDefined();
	});

	it('valid is false when errors exist, true when only warnings', () => {
		const errorBlocks: EditorBlock[] = [
			{ id: '1', type: 'image', content: { src: '', alt: '', width: 100, align: 'center' } },
		];
		const errorResult = validateBlocks(errorBlocks);
		expect(errorResult.valid).toBe(false);

		const warningBlocks: EditorBlock[] = [
			{ id: '1', type: 'text', content: { html: '', blockType: 'paragraph', fontSize: 14, textColor: '#000' } },
		];
		const warningResult = validateBlocks(warningBlocks);
		expect(warningResult.valid).toBe(true);
	});

	it('validates nested blocks inside accordion sections', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'accordion',
				content: {
					sections: [
						{
							id: 'sec1',
							title: 'Section',
							items: [
								{ id: 'img1', type: 'image', content: { src: '', alt: '', width: 100, align: 'center' } },
							],
						},
					],
				},
			},
		];
		const result = validateBlocks(blocks);
		expect(result.valid).toBe(false);
		expect(result.issues.find((i) => i.code === 'IMAGE_NO_SRC')).toBeDefined();
	});
});
