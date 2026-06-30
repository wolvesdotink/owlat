import { describe, it, expect } from 'vitest';
import { renderEmailHtml } from '../../../renderer';
import type { EditorBlock, CarouselBlockContent } from '@owlat/shared';

describe('Carousel Block', () => {
	const makeCarouselBlock = (content: Partial<CarouselBlockContent>): EditorBlock => ({
		id: 'carousel-1',
		type: 'carousel',
		content: {
			images: [
				{ src: 'https://example.com/img1.jpg', alt: 'Image 1' },
				{ src: 'https://example.com/img2.jpg', alt: 'Image 2' },
				{ src: 'https://example.com/img3.jpg', alt: 'Image 3' },
			],
			...content,
		} as CarouselBlockContent,
	});

	it('should render carousel with radio inputs', () => {
		const html = renderEmailHtml([makeCarouselBlock({})], { inlineCss: false });
		expect(html).toContain('type="radio"');
		expect(html).toContain('checked="checked"');
	});

	it('should render all images', () => {
		const html = renderEmailHtml([makeCarouselBlock({})], { inlineCss: false });
		expect(html).toContain('img1.jpg');
		expect(html).toContain('img2.jpg');
		expect(html).toContain('img3.jpg');
	});

	it('should render navigation dots', () => {
		const html = renderEmailHtml([makeCarouselBlock({})], { inlineCss: false });
		expect(html).toContain('border-radius:50%');
	});

	it('should render thumbnail strip when configured', () => {
		const html = renderEmailHtml([makeCarouselBlock({ thumbnailWidth: 60 })], { inlineCss: false });
		expect(html).toContain('thumbs');
	});

	it('should render link-wrapped images', () => {
		const block = makeCarouselBlock({
			images: [
				{ src: 'https://example.com/img1.jpg', alt: 'Image 1', linkUrl: 'https://example.com/page1' },
			],
		});
		const html = renderEmailHtml([block], { inlineCss: false });
		expect(html).toContain('href="https://example.com/page1"');
	});

	it('should return empty for no images', () => {
		const html = renderEmailHtml([makeCarouselBlock({ images: [] })], { inlineCss: false });
		// Should not contain carousel-related markup
		expect(html).not.toContain('type="radio"');
	});

	it('should apply border radius to images', () => {
		const html = renderEmailHtml([makeCarouselBlock({ borderRadius: 8 })], { inlineCss: false });
		expect(html).toContain('border-radius:8px');
	});

	it('should wrap radio inputs in MSO conditional comments', () => {
		const html = renderEmailHtml([makeCarouselBlock({})], { inlineCss: false });
		expect(html).toContain('<!--[if !mso]><!-->');
		expect(html).toContain('<!--<![endif]-->');
	});

	it('should generate global CSS with hide-all then show-checked pattern', () => {
		const html = renderEmailHtml([makeCarouselBlock({})], { inlineCss: false });
		// The "hide all" default rule should exist
		expect(html).toMatch(/div\[class\^="owlat-car-.*-slide"\]\{display:none!important/);
		// The ":checked show" rules should exist
		expect(html).toMatch(/:checked ~ \.owlat-car-.*-slides \.owlat-car-.*-slide-0\{display:block!important/);
	});

	it('should place carousel CSS outside media queries (global rules)', () => {
		const html = renderEmailHtml([makeCarouselBlock({})], { inlineCss: false });
		// Extract the style block content
		const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
		expect(styleMatch).toBeTruthy();
		const styleContent = styleMatch![1];

		// Find the carousel CSS (hide-all rule)
		const hideAllIndex = styleContent.indexOf('div[class^="owlat-car-');
		// Find the media query
		const mediaIndex = styleContent.indexOf('@media only screen and (max-width:');

		// Carousel CSS should appear BEFORE the media query (i.e., outside it)
		expect(hideAllIndex).toBeGreaterThan(-1);
		expect(mediaIndex).toBeGreaterThan(-1);
		expect(hideAllIndex).toBeLessThan(mediaIndex);
	});
});
