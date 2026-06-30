import { describe, it, expect } from 'vitest';
import { renderEmailHtml, renderBlockFragment } from '../renderer';
import type { EditorBlock } from '@owlat/shared';

describe('Global Block Defaults (blockDefaults)', () => {
	it('applies blockDefaults to a divider block', () => {
		const blocks: EditorBlock[] = [
			{
				id: '1',
				type: 'divider',
				content: {
					color: '#000',
					thickness: 1,
					width: 100,
					style: 'solid',
				},
			},
		];

		const html = renderEmailHtml(blocks, {
			theme: {
				blockDefaults: {
					divider: { color: '#e5e7eb', thickness: 2 },
				},
			},
		});

		// Block-level color (#000) should override default (#e5e7eb)
		expect(html).toContain('#000');
	});

	it('uses blockDefaults when block-level value is undefined', () => {
		const block: EditorBlock = {
			id: '1',
			type: 'spacer',
			content: {
				height: 20,
			},
		};

		const html = renderBlockFragment(block, {
			theme: {
				blockDefaults: {
					spacer: { backgroundColor: '#f0f0f0' },
				},
			},
		});

		expect(html).toContain('#f0f0f0');
	});

	it('block-level values override blockDefaults', () => {
		const block: EditorBlock = {
			id: '1',
			type: 'spacer',
			content: {
				height: 40,
				backgroundColor: '#ff0000',
			},
		};

		const html = renderBlockFragment(block, {
			theme: {
				blockDefaults: {
					spacer: { backgroundColor: '#f0f0f0', height: 20 },
				},
			},
		});

		// Block value should win
		expect(html).toContain('#ff0000');
		expect(html).toContain('40px');
	});

	it('buttonDefaults override blockDefaults for button blocks', () => {
		const block: EditorBlock = {
			id: '1',
			type: 'button',
			content: {
				text: 'Click',
				url: 'https://example.com',
				backgroundColor: '',
				textColor: '#ffffff',
				align: 'center',
				borderRadius: 4,
				paddingX: 24,
				paddingY: 12,
			},
		};

		const html = renderBlockFragment(block, {
			theme: {
				blockDefaults: {
					button: { backgroundColor: '#111111' },
				},
				buttonDefaults: {
					backgroundColor: '#222222',
				},
			},
		});

		// buttonDefaults should override blockDefaults
		expect(html).toContain('#222222');
	});

	it('headingDefaults apply when block has no explicit fontSize', () => {
		const block = {
			id: '1',
			type: 'text',
			content: {
				html: '<h1>Title</h1>',
				blockType: 'h1',
				fontSize: undefined,
				textColor: '',
			},
		} as unknown as EditorBlock;

		const html = renderBlockFragment(block, {
			theme: {
				blockDefaults: {
					text: { fontSize: 14 },
				},
				headingDefaults: {
					h1: { fontSize: 32 },
				},
			},
		});

		expect(html).toContain('32px');
	});
});
