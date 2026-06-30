import { describe, it, expect } from 'vitest';
import { imageModule } from '../index';
import type { ImageBlockContent } from '@owlat/shared';
import type { RenderArgs, RenderContext } from '../../_module';

const ctx = { baseWidth: 600, linkTransform: undefined } as RenderContext;
const args = (content: ImageBlockContent, placement: 'root' | 'column' = 'root'): RenderArgs<'image'> => ({
	block: { id: 'b1', type: 'image', content },
	content,
	ctx,
	width: 600,
	placement,
	walk: () => '',
});

describe('imageModule.html', () => {
	it('renders image with correct attributes', () => {
		const content: ImageBlockContent = { src: 'https://example.com/img.jpg', alt: 'Test image', width: 100, align: 'center' };
		const result = imageModule.html(args(content));
		expect(result).toContain('src="https://example.com/img.jpg"');
		expect(result).toContain('alt="Test image"');
		expect(result).toContain('width="600"');
		expect(result).toContain('align="center"');
	});

	it('includes border="0" on img tag', () => {
		const result = imageModule.html(args({ src: 'https://example.com/img.jpg', alt: '', width: 100, align: 'center' }));
		expect(result).toContain('border="0"');
		expect(result).toContain('border:0');
		expect(result).toContain('outline:none');
	});

	it('returns empty string when no src (via isEmpty)', () => {
		const content: ImageBlockContent = { src: '', alt: '', width: 100, align: 'center' };
		expect(imageModule.isEmpty!(content)).toBe(true);
		expect(imageModule.html(args(content))).toBe('');
	});

	it('wraps in link when linkUrl provided', () => {
		const result = imageModule.html(args({ src: 'https://example.com/img.jpg', alt: 'Linked', width: 50, align: 'center', linkUrl: 'https://example.com' }));
		expect(result).toContain('href="https://example.com"');
		expect(result).toContain('<a ');
		expect(result).toContain('target="_blank"');
	});

	it('applies border radius', () => {
		const result = imageModule.html(args({ src: 'https://example.com/img.jpg', alt: '', width: 100, align: 'center', borderRadius: 8 }));
		expect(result).toContain('border-radius:8px');
	});

	it('emits a padding cell at column placement', () => {
		const result = imageModule.html(args({ src: 'https://example.com/img.jpg', alt: '', width: 100, align: 'center' }, 'column'));
		expect(result).toContain('padding:8px 0');
		expect(result).toContain('<img');
	});
});
