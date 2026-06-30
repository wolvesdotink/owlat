import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '../renderer';
import type { EditorBlock } from '@owlat/shared';

describe('Conditional Content Loops (Repeat Blocks)', () => {
	it('repeats a text block for each item in array variable', () => {
		const blocks: EditorBlock[] = [
			{
				id: 'item',
				type: 'text',
				content: {
					html: '<p>Product: {{product.name}} - ${{product.price}}</p>',
					blockType: 'paragraph',
					fontSize: 16,
					textColor: '#333',
					repeat: {
						variable: 'products',
						itemAlias: 'product',
					},
				},
			},
		];

		const html = renderEmailHtml(blocks, {
			variableValues: {
				products: JSON.stringify([
					{ name: 'Widget A', price: '10' },
					{ name: 'Widget B', price: '20' },
					{ name: 'Widget C', price: '30' },
				]),
			},
		});

		expect(html).toContain('Widget A');
		expect(html).toContain('Widget B');
		expect(html).toContain('Widget C');
		expect(html).toContain('$10');
		expect(html).toContain('$20');
		expect(html).toContain('$30');
	});

	it('respects maxItems limit', () => {
		const blocks: EditorBlock[] = [
			{
				id: 'item',
				type: 'text',
				content: {
					html: '<p>{{item.name}}</p>',
					blockType: 'paragraph',
					fontSize: 16,
					textColor: '#333',
					repeat: {
						variable: 'items',
						itemAlias: 'item',
						maxItems: 2,
					},
				},
			},
		];

		const html = renderEmailHtml(blocks, {
			variableValues: {
				items: JSON.stringify([
					{ name: 'A' },
					{ name: 'B' },
					{ name: 'C' },
				]),
			},
		});

		expect(html).toContain('A');
		expect(html).toContain('B');
		expect(html).not.toContain('>C<');
	});

	it('replaces {{$index}} with iteration index', () => {
		const blocks: EditorBlock[] = [
			{
				id: 'item',
				type: 'text',
				content: {
					html: '<p>#{{$index}}: {{row.name}}</p>',
					blockType: 'paragraph',
					fontSize: 16,
					textColor: '#333',
					repeat: {
						variable: 'rows',
						itemAlias: 'row',
					},
				},
			},
		];

		const html = renderEmailHtml(blocks, {
			variableValues: {
				rows: JSON.stringify([{ name: 'First' }, { name: 'Second' }]),
			},
		});

		expect(html).toContain('#0');
		expect(html).toContain('#1');
	});

	it('emits warning for missing variable', () => {
		const warnings: string[] = [];
		const blocks: EditorBlock[] = [
			{
				id: 'item',
				type: 'text',
				content: {
					html: '<p>Test</p>',
					blockType: 'paragraph',
					fontSize: 16,
					textColor: '#333',
					repeat: {
						variable: 'nonexistent',
						itemAlias: 'item',
					},
				},
			},
		];

		renderEmailHtml(blocks, {
			onWarning: (msg) => warnings.push(msg),
		});

		expect(warnings.some((w) => w.includes('nonexistent'))).toBe(true);
	});

	it('emits warning for non-array variable', () => {
		const warnings: string[] = [];
		const blocks: EditorBlock[] = [
			{
				id: 'item',
				type: 'text',
				content: {
					html: '<p>Test</p>',
					blockType: 'paragraph',
					fontSize: 16,
					textColor: '#333',
					repeat: {
						variable: 'notArray',
						itemAlias: 'item',
					},
				},
			},
		];

		renderEmailHtml(blocks, {
			variableValues: { notArray: 'just a string' },
			onWarning: (msg) => warnings.push(msg),
		});

		expect(warnings.some((w) => w.includes('not valid JSON') || w.includes('not an array'))).toBe(true);
	});

	it('blocks without repeat are rendered normally', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'text',
				content: {
					html: '<p>Normal block</p>',
					blockType: 'paragraph',
					fontSize: 16,
					textColor: '#333',
				},
			},
		];

		const html = renderEmailHtml(blocks);
		expect(html).toContain('Normal block');
	});
});
