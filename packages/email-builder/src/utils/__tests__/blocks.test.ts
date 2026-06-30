import { describe, it, expect } from 'vitest';
import {
	createDefaultContent,
	createBlock,
	getBlockPadding,
	updateBlockPadding,
	getBlockBackgroundColor,
	blockSupportsBorderRadius,
	getColumnWidths,
} from '../blocks';
import type {
	TextBlockContent,
	ImageBlockContent,
	ButtonBlockContent,
	DividerBlockContent,
	SpacerBlockContent,
	ColumnsBlockContent,
	SocialBlockContent,
	ContainerBlockContent,
	EditorBlock,
	BlockType,
} from '../../types';

describe('createDefaultContent', () => {
	it('creates text block with correct defaults', () => {
		const content = createDefaultContent('text') as TextBlockContent;
		expect(content.html).toBe('Enter your text here...');
		expect(content.blockType).toBe('paragraph');
		expect(content.fontSize).toBe(16);
		expect(content.textColor).toBe('#374151');
		expect(content.lineHeight).toBe(1.5);
	});

	it('creates image block with correct defaults', () => {
		const content = createDefaultContent('image') as ImageBlockContent;
		expect(content.src).toBe('');
		expect(content.alt).toBe('');
		expect(content.width).toBe(100);
		expect(content.align).toBe('center');
	});

	it('creates button block with correct defaults', () => {
		const content = createDefaultContent('button') as ButtonBlockContent;
		expect(content.text).toBe('Click here');
		expect(content.url).toBe('https://');
		expect(content.backgroundColor).toBe('#c4785a'); // default theme primary
		expect(content.align).toBe('center');
		expect(content.borderRadius).toBe(8);
		expect(content.paddingX).toBe(24);
		expect(content.paddingY).toBe(12);
	});

	it('creates button with correct text color from theme', () => {
		const content = createDefaultContent('button') as ButtonBlockContent;
		// Should compute text color based on primary color luminance
		expect(['#ffffff', '#12110e']).toContain(content.textColor);
	});

	it('creates divider block with correct defaults', () => {
		const content = createDefaultContent('divider') as DividerBlockContent;
		expect(content.color).toBe('#282D3A');
		expect(content.thickness).toBe(1);
		expect(content.width).toBe(100);
		expect(content.style).toBe('solid');
	});

	it('creates spacer block with correct defaults', () => {
		const content = createDefaultContent('spacer') as SpacerBlockContent;
		expect(content.height).toBe(20);
	});

	it('creates columns block with correct defaults', () => {
		const content = createDefaultContent('columns') as ColumnsBlockContent;
		expect(content.columnCount).toBe(2);
		expect(content.ratio).toBe('equal');
		expect(content.mobileStacking).toBe(true);
		expect(content.columns).toEqual([[], []]);
	});

	it('creates social block with correct defaults', () => {
		const content = createDefaultContent('social') as SocialBlockContent;
		expect(content.links).toHaveLength(5);
		expect(content.links[0].platform).toBe('twitter');
		expect(content.links[0].enabled).toBe(true);
		expect(content.links[4].platform).toBe('youtube');
		expect(content.links[4].enabled).toBe(false);
		expect(content.iconStyle).toBe('filled');
		expect(content.align).toBe('center');
		expect(content.iconSize).toBe(64);
	});

	it('creates container block with correct defaults', () => {
		const content = createDefaultContent('container') as ContainerBlockContent;
		expect(content.items).toEqual([]);
		expect(content.maxWidth).toBe(100);
		expect(content.paddingTop).toBe(16);
		expect(content.paddingRight).toBe(24);
		expect(content.paddingBottom).toBe(16);
		expect(content.paddingLeft).toBe(24);
		expect(content.borderRadius).toBe(8);
		expect(content.borderWidth).toBe(0);
	});

	it('uses custom theme for button color', () => {
		const content = createDefaultContent('button', {
			primaryColor: '#ff0000',
		}) as ButtonBlockContent;
		expect(content.backgroundColor).toBe('#ff0000');
	});
});

describe('createBlock', () => {
	it('returns block with id, type, and content', () => {
		const block = createBlock('text');
		expect(block.id).toBeDefined();
		expect(block.id).toMatch(/^block-/);
		expect(block.type).toBe('text');
		expect(block.content).toBeDefined();
	});

	it('creates unique ids', () => {
		const block1 = createBlock('text');
		const block2 = createBlock('text');
		expect(block1.id).not.toBe(block2.id);
	});

	it('creates block with correct type for each block type', () => {
		const types: BlockType[] = [
			'text',
			'image',
			'button',
			'divider',
			'spacer',
			'columns',
			'social',
			'container',
		];
		for (const type of types) {
			const block = createBlock(type);
			expect(block.type).toBe(type);
		}
	});
});

describe('getBlockPadding', () => {
	it('returns padding from block content', () => {
		const block: EditorBlock = {
			id: 'test',
			type: 'text',
			content: {
				html: 'test',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#000',
				paddingTop: 10,
				paddingRight: 20,
				paddingBottom: 30,
				paddingLeft: 40,
				paddingLinked: true,
			} as TextBlockContent,
		};
		const padding = getBlockPadding(block);
		expect(padding).toEqual({
			paddingTop: 10,
			paddingRight: 20,
			paddingBottom: 30,
			paddingLeft: 40,
			paddingLinked: true,
		});
	});

	it('returns defaults for missing padding values', () => {
		const block: EditorBlock = {
			id: 'test',
			type: 'text',
			content: {
				html: 'test',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#000',
			} as TextBlockContent,
		};
		const padding = getBlockPadding(block);
		expect(padding.paddingTop).toBe(16);
		expect(padding.paddingRight).toBe(24);
		expect(padding.paddingBottom).toBe(16);
		expect(padding.paddingLeft).toBe(24);
		expect(padding.paddingLinked).toBe(false);
	});
});

describe('updateBlockPadding', () => {
	it('updates a single padding side', () => {
		const block: EditorBlock = {
			id: 'test',
			type: 'text',
			content: {
				html: 'test',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#000',
				paddingTop: 10,
				paddingRight: 10,
				paddingBottom: 10,
				paddingLeft: 10,
				paddingLinked: false,
			} as TextBlockContent,
		};
		updateBlockPadding(block, 'paddingTop', 50);
		expect((block.content as TextBlockContent).paddingTop).toBe(50);
		expect((block.content as TextBlockContent).paddingRight).toBe(10); // unchanged
	});

	it('syncs all sides when paddingLinked is true', () => {
		const block: EditorBlock = {
			id: 'test',
			type: 'text',
			content: {
				html: 'test',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#000',
				paddingTop: 10,
				paddingRight: 10,
				paddingBottom: 10,
				paddingLeft: 10,
				paddingLinked: true,
			} as TextBlockContent,
		};
		updateBlockPadding(block, 'paddingTop', 50);
		const content = block.content as TextBlockContent;
		expect(content.paddingTop).toBe(50);
		expect(content.paddingRight).toBe(50);
		expect(content.paddingBottom).toBe(50);
		expect(content.paddingLeft).toBe(50);
	});

	it('updates paddingLinked flag', () => {
		const block: EditorBlock = {
			id: 'test',
			type: 'text',
			content: {
				html: 'test',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#000',
				paddingLinked: false,
			} as TextBlockContent,
		};
		updateBlockPadding(block, 'paddingLinked', true);
		expect((block.content as TextBlockContent).paddingLinked).toBe(true);
	});
});

describe('getBlockBackgroundColor', () => {
	it('returns transparent as default for non-button blocks', () => {
		const block: EditorBlock = {
			id: 'test',
			type: 'text',
			content: {
				html: 'test',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#000',
			} as TextBlockContent,
		};
		expect(getBlockBackgroundColor(block)).toBe('transparent');
	});

	it('returns backgroundColor from non-button block', () => {
		const block: EditorBlock = {
			id: 'test',
			type: 'text',
			content: {
				html: 'test',
				blockType: 'paragraph',
				fontSize: 16,
				textColor: '#000',
				backgroundColor: '#ff0000',
			} as TextBlockContent,
		};
		expect(getBlockBackgroundColor(block)).toBe('#ff0000');
	});

	it('returns blockBackgroundColor for button blocks', () => {
		const block: EditorBlock = {
			id: 'test',
			type: 'button',
			content: {
				text: 'Click',
				url: 'https://',
				backgroundColor: '#c4785a',
				textColor: '#fff',
				align: 'center',
				borderRadius: 8,
				paddingX: 24,
				paddingY: 12,
				blockBackgroundColor: '#00ff00',
			} as ButtonBlockContent,
		};
		expect(getBlockBackgroundColor(block)).toBe('#00ff00');
	});

	it('returns transparent for button without blockBackgroundColor', () => {
		const block: EditorBlock = {
			id: 'test',
			type: 'button',
			content: {
				text: 'Click',
				url: 'https://',
				backgroundColor: '#c4785a',
				textColor: '#fff',
				align: 'center',
				borderRadius: 8,
				paddingX: 24,
				paddingY: 12,
			} as ButtonBlockContent,
		};
		expect(getBlockBackgroundColor(block)).toBe('transparent');
	});
});

describe('blockSupportsBorderRadius', () => {
	it('returns true for text', () => {
		expect(
			blockSupportsBorderRadius({ id: 't', type: 'text', content: {} as TextBlockContent })
		).toBe(true);
	});

	it('returns true for image', () => {
		expect(
			blockSupportsBorderRadius({ id: 't', type: 'image', content: {} as ImageBlockContent })
		).toBe(true);
	});

	it('returns true for button', () => {
		expect(
			blockSupportsBorderRadius({ id: 't', type: 'button', content: {} as ButtonBlockContent })
		).toBe(true);
	});

	it('returns true for columns', () => {
		expect(
			blockSupportsBorderRadius({
				id: 't',
				type: 'columns',
				content: {} as ColumnsBlockContent,
			})
		).toBe(true);
	});

	it('returns false for divider', () => {
		expect(
			blockSupportsBorderRadius({
				id: 't',
				type: 'divider',
				content: {} as DividerBlockContent,
			})
		).toBe(false);
	});

	it('returns false for spacer', () => {
		expect(
			blockSupportsBorderRadius({ id: 't', type: 'spacer', content: {} as SpacerBlockContent })
		).toBe(false);
	});

	it('returns false for social', () => {
		expect(
			blockSupportsBorderRadius({ id: 't', type: 'social', content: {} as SocialBlockContent })
		).toBe(false);
	});

	it('returns false for container', () => {
		expect(
			blockSupportsBorderRadius({
				id: 't',
				type: 'container',
				content: {} as ContainerBlockContent,
			})
		).toBe(false);
	});
});

describe('getColumnWidths', () => {
	describe('1 column', () => {
		it('returns 100% for single column', () => {
			expect(getColumnWidths(1, 'equal')).toEqual(['100%']);
		});

		it('returns 100% regardless of ratio', () => {
			expect(getColumnWidths(1, 'left-wide')).toEqual(['100%']);
		});
	});

	describe('2 columns', () => {
		it('returns 50/50 for equal', () => {
			expect(getColumnWidths(2, 'equal')).toEqual(['50%', '50%']);
		});

		it('returns 67/33 for left-wide', () => {
			expect(getColumnWidths(2, 'left-wide')).toEqual(['67%', '33%']);
		});

		it('returns 33/67 for right-wide', () => {
			expect(getColumnWidths(2, 'right-wide')).toEqual(['33%', '67%']);
		});

		it('returns 33/67 for left-narrow', () => {
			expect(getColumnWidths(2, 'left-narrow')).toEqual(['33%', '67%']);
		});

		it('returns 67/33 for right-narrow', () => {
			expect(getColumnWidths(2, 'right-narrow')).toEqual(['67%', '33%']);
		});

		it('defaults to 50/50 for unknown ratio', () => {
			expect(getColumnWidths(2, 'unknown')).toEqual(['50%', '50%']);
		});
	});

	describe('3 columns', () => {
		it('returns equal thirds for equal', () => {
			expect(getColumnWidths(3, 'equal')).toEqual(['33.33%', '33.33%', '33.33%']);
		});

		it('returns 50/25/25 for left-wide', () => {
			expect(getColumnWidths(3, 'left-wide')).toEqual(['50%', '25%', '25%']);
		});

		it('returns 25/25/50 for right-wide', () => {
			expect(getColumnWidths(3, 'right-wide')).toEqual(['25%', '25%', '50%']);
		});

		it('returns 25/37.5/37.5 for left-narrow', () => {
			expect(getColumnWidths(3, 'left-narrow')).toEqual(['25%', '37.5%', '37.5%']);
		});

		it('returns 37.5/37.5/25 for right-narrow', () => {
			expect(getColumnWidths(3, 'right-narrow')).toEqual(['37.5%', '37.5%', '25%']);
		});

		it('defaults to equal thirds for unknown ratio', () => {
			expect(getColumnWidths(3, 'unknown')).toEqual(['33.33%', '33.33%', '33.33%']);
		});
	});
});
