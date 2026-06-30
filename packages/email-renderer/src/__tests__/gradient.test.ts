import { describe, it, expect } from 'vitest';
import { renderBlockFragment } from '../renderer';
import type { EditorBlock } from '@owlat/shared';

describe('Gradient Background Support', () => {
	it('renders CSS gradient on button', () => {
		const block: EditorBlock = {
			id: '1',
			type: 'button',
			content: {
				text: 'Gradient Button',
				url: 'https://example.com',
				backgroundColor: '#ff0000',
				textColor: '#ffffff',
				align: 'center',
				borderRadius: 8,
				paddingX: 24,
				paddingY: 12,
				backgroundGradient: {
					direction: 'to right',
					stops: [
						{ color: '#ff0000', position: 0 },
						{ color: '#0000ff', position: 100 },
					],
				},
			},
		};

		const html = renderBlockFragment(block);
		expect(html).toContain('linear-gradient(to right, #ff0000 0%, #0000ff 100%)');
		// Should also have solid fallback
		expect(html).toContain('background-color:#ff0000');
	});

	it('renders VML gradient fill for Outlook', () => {
		const block: EditorBlock = {
			id: '1',
			type: 'button',
			content: {
				text: 'VML Gradient',
				url: 'https://example.com',
				backgroundColor: '#ff0000',
				textColor: '#ffffff',
				align: 'center',
				borderRadius: 8,
				paddingX: 24,
				paddingY: 12,
				backgroundGradient: {
					direction: '135deg',
					stops: [
						{ color: '#ff0000', position: 0 },
						{ color: '#ff8800', position: 50 },
						{ color: '#0000ff', position: 100 },
					],
				},
			},
		};

		const html = renderBlockFragment(block);
		// VML should use first and last stop colors
		expect(html).toContain('v:fill');
		expect(html).toContain('type="gradient"');
		expect(html).toContain('color="#ff0000"');
		expect(html).toContain('color2="#0000ff"');
	});

	it('renders normal button when no gradient', () => {
		const block: EditorBlock = {
			id: '1',
			type: 'button',
			content: {
				text: 'Normal',
				url: 'https://example.com',
				backgroundColor: '#333333',
				textColor: '#ffffff',
				align: 'center',
				borderRadius: 4,
				paddingX: 24,
				paddingY: 12,
			},
		};

		const html = renderBlockFragment(block);
		expect(html).not.toContain('linear-gradient');
		expect(html).not.toContain('v:fill');
		expect(html).toContain('fillcolor="#333333"');
	});

	it('renders CSS gradient on container block', () => {
		const block: EditorBlock = {
			id: '1',
			type: 'container',
			content: {
				items: [
					{
						id: 'item-1',
						type: 'text',
						content: { html: 'Hello', fontSize: 16, textColor: '#000', lineHeight: 1.5, blockType: 'paragraph' },
					},
				],
				backgroundColor: '#ff0000',
				maxWidth: 100,
				backgroundGradient: {
					direction: '135deg',
					stops: [
						{ color: '#ff0000', position: 0 },
						{ color: '#00ff00', position: 100 },
					],
				},
			},
		};

		const html = renderBlockFragment(block);
		expect(html).toContain('linear-gradient(135deg, #ff0000 0%, #00ff00 100%)');
		// Should also have solid bg fallback
		expect(html).toContain('background-color:#ff0000');
	});

	it('renders CSS gradient on hero block', () => {
		const block: EditorBlock = {
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
				backgroundGradient: {
					direction: 'to bottom',
					stops: [
						{ color: '#000000', position: 0 },
						{ color: '#ffffff', position: 100 },
					],
				},
			},
		};

		const html = renderBlockFragment(block);
		expect(html).toContain('linear-gradient(to bottom, #000000 0%, #ffffff 100%)');
	});

	it('renders hero with gradient + background image', () => {
		const block: EditorBlock = {
			id: '1',
			type: 'hero',
			content: {
				backgroundImage: 'https://example.com/hero.jpg',
				backgroundPosition: 'center',
				backgroundSize: 'cover',
				height: 400,
				mode: 'fixed-height',
				verticalAlign: 'middle',
				items: [],
				backgroundGradient: {
					direction: 'to right',
					stops: [
						{ color: '#ff0000', position: 0 },
						{ color: '#0000ff', position: 100 },
					],
				},
			},
		};

		const html = renderBlockFragment(block);
		// Both gradient and background image should be present
		expect(html).toContain('linear-gradient(to right, #ff0000 0%, #0000ff 100%)');
		expect(html).toContain('background-image:url');
		expect(html).toContain('hero.jpg');
	});
});
