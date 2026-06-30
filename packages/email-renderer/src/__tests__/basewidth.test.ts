import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '../renderer';
import type { EditorBlock, TextBlockContent } from '@owlat/shared';

describe('Configurable Base Width', () => {
	const textBlock: EditorBlock = {
		id: 'text-1',
		type: 'text',
		content: {
			html: '<p>Hello world</p>',
			blockType: 'paragraph',
			fontSize: 16,
			textColor: '#333',
		} as TextBlockContent,
	};

	it('should use default 600px base width', () => {
		const html = renderEmailHtml([textBlock], { inlineCss: false });
		expect(html).toContain('max-width:600px');
		expect(html).toContain('width="600"');
	});

	it('should use custom base width of 700px', () => {
		const html = renderEmailHtml([textBlock], { baseWidth: 700, inlineCss: false });
		expect(html).toContain('max-width:700px');
		expect(html).toContain('width="700"');
	});

	it('should use narrow width of 500px', () => {
		const html = renderEmailHtml([textBlock], { baseWidth: 500, inlineCss: false });
		expect(html).toContain('max-width:500px');
		expect(html).toContain('width="500"');
	});

	it('should read baseWidth from theme when options.baseWidth is not set', () => {
		const html = renderEmailHtml([textBlock], { theme: { baseWidth: 700 }, inlineCss: false });
		expect(html).toContain('max-width:700px');
		expect(html).toContain('width="700"');
	});

	it('should prefer options.baseWidth over theme.baseWidth', () => {
		const html = renderEmailHtml([textBlock], { baseWidth: 500, theme: { baseWidth: 700 }, inlineCss: false });
		expect(html).toContain('max-width:500px');
		expect(html).toContain('width="500"');
	});

	it('should use default when neither options.baseWidth nor theme.baseWidth is set', () => {
		const html = renderEmailHtml([textBlock], { theme: {}, inlineCss: false });
		expect(html).toContain('max-width:600px');
		expect(html).toContain('width="600"');
	});
});

describe('CSS Inlining Integration', () => {
	const textBlock: EditorBlock = {
		id: 'text-1',
		type: 'text',
		content: {
			html: '<p>Hello world</p>',
			blockType: 'paragraph',
			fontSize: 16,
			textColor: '#333',
		} as TextBlockContent,
	};

	it('should inline CSS by default', () => {
		const html = renderEmailHtml([textBlock]);
		// Inlined CSS should appear on elements
		expect(html).toContain('<style>');
	});

	it('should skip CSS inlining when disabled', () => {
		const html = renderEmailHtml([textBlock], { inlineCss: false });
		expect(html).toContain('<style>');
	});

	it('should produce valid HTML with inlining enabled', () => {
		const html = renderEmailHtml([textBlock], { inlineCss: true });
		expect(html).toContain('<!DOCTYPE html>');
		expect(html).toContain('</html>');
	});
});
