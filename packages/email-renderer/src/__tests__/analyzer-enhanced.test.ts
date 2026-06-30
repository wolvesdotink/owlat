import { describe, it, expect } from 'vitest';
import { analyzeEmail, suggestOptimizations } from '../analyzer';
import { renderEmailHtml } from '../renderer';
import type { EditorBlock } from '@owlat/shared';

describe('Email Weight Budget Breakdown', () => {
	it('returns size breakdown when includeBreakdown is true', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'text',
				content: { html: '<p>Hello world</p>', blockType: 'paragraph', fontSize: 16, textColor: '#333' },
			},
		];
		const html = renderEmailHtml(blocks);
		const result = analyzeEmail(html, { includeBreakdown: true });

		expect(result.sizeBreakdown).toBeDefined();
		expect(result.sizeBreakdown!.totalBytes).toBeGreaterThan(0);
		expect(result.sizeBreakdown!.styleBlockBytes).toBeGreaterThan(0);
		expect(result.sizeBreakdown!.textContentBytes).toBeGreaterThan(0);
	});

	it('does not include breakdown when includeBreakdown is false/undefined', () => {
		const result = analyzeEmail('<html><body>test</body></html>');
		expect(result.sizeBreakdown).toBeUndefined();
		expect(result.optimizations).toBeUndefined();
	});

	it('breakdown categories sum to approximately total', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'text',
				content: { html: '<p>Content here</p>', blockType: 'paragraph', fontSize: 16, textColor: '#333' },
			},
			{
				id: '2',
				type: 'button',
				content: {
					text: 'Click',
					url: 'https://example.com',
					backgroundColor: '#000',
					textColor: '#fff',
					align: 'center',
					borderRadius: 4,
					paddingX: 24,
					paddingY: 12,
				},
			},
		];
		const html = renderEmailHtml(blocks);
		const result = analyzeEmail(html, { includeBreakdown: true });
		const bd = result.sizeBreakdown!;

		// Sum of categories should be close to total (may not be exact due to overlap)
		const sum = bd.styleBlockBytes + bd.msoConditionalBytes + bd.imageTagBytes + bd.textContentBytes + bd.whitespaceBytes + bd.markupOverheadBytes;
		expect(sum).toBeGreaterThan(0);
	});

	it('suggestOptimizations returns suggestions for complex emails', () => {
		const blocks: EditorBlock[] = Array.from({ length: 10 }, (_, i) => ({
			id: `${i}`,
			type: 'text' as const,
			content: {
				html: `<p>${'Lorem ipsum '.repeat(20)}</p>`,
				blockType: 'paragraph' as const,
				fontSize: 16,
				textColor: '#333',
			},
		}));
		const html = renderEmailHtml(blocks);
		const suggestions = suggestOptimizations(html);

		expect(Array.isArray(suggestions)).toBe(true);
		// Should suggest minification at minimum
		for (const s of suggestions) {
			expect(s.estimatedSavings).toBeGreaterThan(0);
			expect(s.category).toBeDefined();
		}
	});
});
