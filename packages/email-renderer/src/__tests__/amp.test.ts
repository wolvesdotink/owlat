import { describe, it, expect } from 'vitest';
import { renderAmpEmail } from '../amp';
import type { EditorBlock } from '@owlat/shared';

describe('AMP Email Output', () => {
	it('renders valid AMP4Email boilerplate', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'text',
				content: { html: '<p>Hello</p>', blockType: 'paragraph', fontSize: 16, textColor: '#333' },
			},
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('⚡4email');
		expect(html).toContain('amp4email-boilerplate');
		expect(html).toContain('cdn.ampproject.org/v0.js');
	});

	it('renders text blocks as semantic HTML', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'text', content: { html: '<h1>Title</h1>', blockType: 'h1', fontSize: 32, textColor: '#000' } },
			{ id: '2', type: 'text', content: { html: '<p>Body</p>', blockType: 'paragraph', fontSize: 16, textColor: '#333' } },
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('<h1');
		expect(html).toContain('<p');
	});

	it('renders images as amp-img', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'image',
				content: { src: 'https://example.com/img.png', alt: 'Photo', width: 300, align: 'center' },
			},
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('<amp-img');
		expect(html).toContain('layout="responsive"');
		expect(html).toContain('src="https://example.com/img.png"');
	});

	it('renders buttons as styled links', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'button',
				content: {
					text: 'Click Me',
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

		const html = renderAmpEmail(blocks);
		expect(html).toContain('Click Me');
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('owlat-btn');
	});

	it('includes amp-accordion script for accordion blocks', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'accordion',
				content: {
					sections: [
						{ id: 's1', title: 'Section 1', items: [] },
					],
				},
			},
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('amp-accordion');
		expect(html).toContain('amp-accordion-0.1.js');
	});

	it('includes amp-carousel script for carousel blocks', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'carousel',
				content: {
					images: [
						{ src: 'https://example.com/1.png', alt: 'Img 1' },
						{ src: 'https://example.com/2.png', alt: 'Img 2' },
					],
				},
			},
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('amp-carousel');
		expect(html).toContain('type="slides"');
	});

	it('renders rawHtml (no AMP equivalent) as a skipped-block comment', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'rawHtml',
				content: { html: '<div>custom</div>' },
			},
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('<!-- AMP: rawHtml block not supported -->');
	});

	it('recurses columns and keeps nested block content', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'columns',
				content: {
					columnCount: 2,
					ratio: 'equal',
					mobileStacking: true,
					columns: [
						[{ id: 'c1', type: 'text', content: { html: '<p>Left</p>', blockType: 'paragraph', fontSize: 16, textColor: '#333' } }],
						[{ id: 'c2', type: 'button', content: { text: 'Go', url: 'https://example.com', backgroundColor: '#000', textColor: '#fff', align: 'center', borderRadius: 4, paddingX: 24, paddingY: 12 } }],
					],
				},
			},
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('Left');
		expect(html).toContain('href="https://example.com"');
		expect(html).not.toContain('columns block not supported');
	});

	it('recurses hero and keeps nested block content', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'hero',
				content: {
					backgroundImage: 'https://example.com/bg.png',
					backgroundPosition: 'center',
					backgroundSize: 'cover',
					height: 400,
					mode: 'fixed-height',
					verticalAlign: 'middle',
					overlayColor: '#101010',
					items: [
						{ id: 'h1', type: 'text', content: { html: '<h1>Welcome</h1>', blockType: 'h1', fontSize: 32, textColor: '#fff' } },
					],
				},
			},
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('Welcome');
		expect(html).toContain('background-color:#101010');
		expect(html).not.toContain('hero block not supported');
	});

	it('renders table as AMP-valid table markup', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'table',
				content: {
					headers: ['A', 'B'],
					rows: [['1', '2']],
					headerBackgroundColor: '#f5f5f5',
					headerTextColor: '#333',
					borderColor: '#e0e0e0',
					striped: false,
					stripeColor: '#fafafa',
					cellPadding: 8,
					textAlign: 'left',
				},
			},
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('<table');
		expect(html).toContain('>A<');
		expect(html).not.toContain('table block not supported');
		expect(html).not.toContain('<img');
	});

	it('renders list, progress bar, menu without dropping to comments', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'list', content: { items: ['One', 'Two'], listType: 'bullet', fontSize: 16, textColor: '#333' } },
			{ id: '2', type: 'progressBar', content: { value: 50, barColor: '#000', trackColor: '#ccc', height: 20 } },
			{ id: '3', type: 'menu', content: { items: [{ label: 'Home', url: 'https://example.com' }], align: 'center', fontSize: 14, textColor: '#333' } },
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('One');
		expect(html).toContain('Home');
		expect(html).not.toContain('block not supported');
	});

	it('renders image-bearing blocks (social, video) as amp-img', () => {
		const blocks: EditorBlock[] = [
			{ id: '1', type: 'social', content: { links: [{ platform: 'twitter', url: 'https://x.com/owlat', enabled: true }], iconStyle: 'filled', align: 'center', iconSize: 32, iconSpacing: 12 } },
			{ id: '2', type: 'video', content: { thumbnailUrl: 'https://example.com/thumb.png', videoUrl: 'https://example.com/watch', alt: 'Clip', width: 100, align: 'center' } },
		];

		const html = renderAmpEmail(blocks);
		expect(html).toContain('<amp-img');
		expect(html).toContain('href="https://example.com/watch"');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('block not supported');
	});

	it('respects baseWidth option', () => {
		const blocks: EditorBlock[] = [];
		const html = renderAmpEmail(blocks, { baseWidth: 800 });
		expect(html).toContain('max-width:800px');
	});
});
