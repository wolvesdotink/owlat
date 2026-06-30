import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { useBlockManagement } from '../useBlockManagement';
import type {
	EditorBlock,
	TextBlockContent,
	ColumnsBlockContent,
	ContainerBlockContent,
	EmailTheme,
} from '../../types';

// Ensure block definitions are registered
import '../../registry';

const defaultTheme: Required<EmailTheme> = {
	primaryColor: '#3b82f6',
	fontFamily: 'Arial, sans-serif',
	backgroundColor: '#ffffff',
	headingFontFamily: 'Arial, sans-serif',
	bodyFontSize: 16,
	bodyTextColor: '#374151',
	linkColor: '#3b82f6',
	borderRadius: 8,
	spacingUnit: 16,
	buttonDefaults: {},
	headingDefaults: {},
	blockDefaults: {},
};

function makeTextBlock(id: string): EditorBlock {
	return {
		id,
		type: 'text',
		content: {
			html: 'Hello',
			blockType: 'paragraph',
			fontSize: 16,
			textColor: '#000',
			lineHeight: 1.5,
			paddingTop: 16,
			paddingRight: 24,
			paddingBottom: 16,
			paddingLeft: 24,
			paddingLinked: false,
			marginTop: 0,
			marginRight: 0,
			marginBottom: 0,
			marginLeft: 0,
		},
	};
}

function makeColumnsBlock(id: string): EditorBlock {
	return {
		id,
		type: 'columns',
		content: {
			columnCount: 2,
			ratio: 'equal',
			mobileStacking: true,
			columns: [
				[{ id: 'col-item-1', type: 'text', content: { html: 'Col 1' } }],
				[{ id: 'col-item-2', type: 'button', content: { text: 'Click' } }],
			],
			gap: 16,
			paddingTop: 0,
			paddingRight: 0,
			paddingBottom: 0,
			paddingLeft: 0,
			paddingLinked: false,
			marginTop: 0,
			marginRight: 0,
			marginBottom: 0,
			marginLeft: 0,
		} as ColumnsBlockContent,
	};
}

function makeContainerBlock(id: string): EditorBlock {
	return {
		id,
		type: 'container',
		content: {
			items: [
				{ id: 'citem-1', type: 'text', content: { html: 'Inside' } },
				{
					id: 'citem-2',
					type: 'container',
					content: {
						items: [
							{ id: 'nested-1', type: 'text', content: { html: 'Nested' } },
						],
						backgroundColor: '#fff',
						paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
						paddingLinked: true,
						marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
					} as ContainerBlockContent,
				},
			],
			backgroundColor: '#f0f0f0',
			paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
			paddingLinked: true,
			marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
		} as ContainerBlockContent,
	};
}

function setup(blocks: EditorBlock[] = []) {
	const canvasBlocks = ref(blocks);
	const selectedBlockId = ref<string | null>(null);
	const theme = ref(defaultTheme);
	const onBlockDeleted = vi.fn();
	const onColumnItemDeleted = vi.fn();
	const onContainerItemDeleted = vi.fn();

	const mgmt = useBlockManagement({
		canvasBlocks,
		selectedBlockId,
		theme,
		onBlockDeleted,
		onColumnItemDeleted,
		onContainerItemDeleted,
	});

	return {
		canvasBlocks,
		selectedBlockId,
		...mgmt,
		onBlockDeleted,
		onColumnItemDeleted,
		onContainerItemDeleted,
	};
}

describe('useBlockManagement', () => {
	describe('handleAddBlock', () => {
		it('adds a block and selects it', () => {
			const ctx = setup();
			const block = ctx.handleAddBlock('text');
			expect(ctx.canvasBlocks.value).toHaveLength(1);
			expect(ctx.canvasBlocks.value[0]!.id).toBe(block.id);
			expect(ctx.selectedBlockId.value).toBe(block.id);
		});

		it('appends to end when no afterBlockId', () => {
			const ctx = setup([makeTextBlock('existing')]);
			const block = ctx.handleAddBlock('image');
			expect(ctx.canvasBlocks.value).toHaveLength(2);
			expect(ctx.canvasBlocks.value[1]!.id).toBe(block.id);
		});

		it('inserts after specified block', () => {
			const ctx = setup([makeTextBlock('b1'), makeTextBlock('b2'), makeTextBlock('b3')]);
			const block = ctx.handleAddBlock('button', 'b1');
			expect(ctx.canvasBlocks.value).toHaveLength(4);
			expect(ctx.canvasBlocks.value[1]!.id).toBe(block.id);
			expect(ctx.canvasBlocks.value[2]!.id).toBe('b2');
		});

		it('appends when afterBlockId is not found', () => {
			const ctx = setup([makeTextBlock('b1')]);
			const block = ctx.handleAddBlock('text', 'nonexistent');
			expect(ctx.canvasBlocks.value).toHaveLength(2);
			expect(ctx.canvasBlocks.value[1]!.id).toBe(block.id);
		});

		it('creates block with correct default content', () => {
			const ctx = setup();
			const block = ctx.handleAddBlock('text');
			const content = block.content as TextBlockContent;
			expect(content.html).toBeTruthy();
			expect(content.blockType).toBe('paragraph');
		});

		it('generates unique IDs', () => {
			const ctx = setup();
			const b1 = ctx.handleAddBlock('text');
			const b2 = ctx.handleAddBlock('text');
			expect(b1.id).not.toBe(b2.id);
		});
	});

	describe('handleAddHeadingBlock', () => {
		it('creates h1 heading with correct font size', () => {
			const ctx = setup();
			const block = ctx.handleAddHeadingBlock(1);
			const content = block.content as TextBlockContent;
			expect(block.type).toBe('text');
			expect(content.blockType).toBe('h1');
			expect(content.fontSize).toBe(32);
			expect(content.html).toBe('Heading 1');
		});

		it('creates h2 heading with correct font size', () => {
			const ctx = setup();
			const block = ctx.handleAddHeadingBlock(2);
			const content = block.content as TextBlockContent;
			expect(content.blockType).toBe('h2');
			expect(content.fontSize).toBe(24);
			expect(content.html).toBe('Heading 2');
		});

		it('creates h3 heading with correct font size', () => {
			const ctx = setup();
			const block = ctx.handleAddHeadingBlock(3);
			const content = block.content as TextBlockContent;
			expect(content.blockType).toBe('h3');
			expect(content.fontSize).toBe(20);
			expect(content.html).toBe('Heading 3');
		});

		it('inserts after specified block', () => {
			const ctx = setup([makeTextBlock('b1'), makeTextBlock('b2')]);
			const block = ctx.handleAddHeadingBlock(1, 'b1');
			expect(ctx.canvasBlocks.value[1]!.id).toBe(block.id);
		});
	});

	describe('handleDeleteBlock', () => {
		it('removes a block by ID', () => {
			const ctx = setup([makeTextBlock('b1'), makeTextBlock('b2')]);
			ctx.handleDeleteBlock('b1');
			expect(ctx.canvasBlocks.value).toHaveLength(1);
			expect(ctx.canvasBlocks.value[0]!.id).toBe('b2');
		});

		it('clears selection if deleted block was selected', () => {
			const ctx = setup([makeTextBlock('b1')]);
			ctx.selectedBlockId.value = 'b1';
			ctx.handleDeleteBlock('b1');
			expect(ctx.selectedBlockId.value).toBeNull();
		});

		it('preserves selection if different block was deleted', () => {
			const ctx = setup([makeTextBlock('b1'), makeTextBlock('b2')]);
			ctx.selectedBlockId.value = 'b2';
			ctx.handleDeleteBlock('b1');
			expect(ctx.selectedBlockId.value).toBe('b2');
		});

		it('calls onBlockDeleted callback', () => {
			const ctx = setup([makeTextBlock('b1')]);
			ctx.handleDeleteBlock('b1');
			expect(ctx.onBlockDeleted).toHaveBeenCalledWith('b1');
		});

		it('calls onColumnItemDeleted for columns block items', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			ctx.handleDeleteBlock('cols-1');
			expect(ctx.onColumnItemDeleted).toHaveBeenCalledWith('col-item-1');
			expect(ctx.onColumnItemDeleted).toHaveBeenCalledWith('col-item-2');
		});

		it('does nothing for nonexistent block', () => {
			const ctx = setup([makeTextBlock('b1')]);
			ctx.handleDeleteBlock('nonexistent');
			expect(ctx.canvasBlocks.value).toHaveLength(1);
			expect(ctx.onBlockDeleted).not.toHaveBeenCalled();
		});
	});

	describe('handleDuplicateBlock', () => {
		it('duplicates a block after the original', () => {
			const ctx = setup([makeTextBlock('b1'), makeTextBlock('b2')]);
			ctx.handleDuplicateBlock('b1');
			expect(ctx.canvasBlocks.value).toHaveLength(3);
			expect(ctx.canvasBlocks.value[0]!.id).toBe('b1');
			expect(ctx.canvasBlocks.value[1]!.type).toBe('text');
			expect(ctx.canvasBlocks.value[1]!.id).not.toBe('b1');
			expect(ctx.canvasBlocks.value[2]!.id).toBe('b2');
		});

		it('deep-clones content (no shared references)', () => {
			const ctx = setup([makeTextBlock('b1')]);
			ctx.handleDuplicateBlock('b1');
			const original = ctx.canvasBlocks.value[0]!.content as TextBlockContent;
			const copy = ctx.canvasBlocks.value[1]!.content as TextBlockContent;
			original.html = 'modified';
			expect(copy.html).not.toBe('modified');
		});

		it('selects the duplicated block', () => {
			const ctx = setup([makeTextBlock('b1')]);
			ctx.handleDuplicateBlock('b1');
			expect(ctx.selectedBlockId.value).toBe(ctx.canvasBlocks.value[1]!.id);
		});

		it('does nothing for nonexistent block', () => {
			const ctx = setup([makeTextBlock('b1')]);
			ctx.handleDuplicateBlock('nonexistent');
			expect(ctx.canvasBlocks.value).toHaveLength(1);
		});
	});

	describe('handleAddItemToColumn', () => {
		it('adds an item to the specified column', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			const item = ctx.handleAddItemToColumn('cols-1', 0, 'text');
			expect(item).not.toBeNull();
			const content = ctx.canvasBlocks.value[0]!.content as ColumnsBlockContent;
			expect(content.columns[0]).toHaveLength(2); // original + new
		});

		it('returns null for non-columns block', () => {
			const ctx = setup([makeTextBlock('b1')]);
			const item = ctx.handleAddItemToColumn('b1', 0, 'text');
			expect(item).toBeNull();
		});

		it('returns null for invalid column index', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			const item = ctx.handleAddItemToColumn('cols-1', 99, 'text');
			expect(item).toBeNull();
		});

		it('returns null for nonexistent block', () => {
			const ctx = setup();
			const item = ctx.handleAddItemToColumn('nonexistent', 0, 'text');
			expect(item).toBeNull();
		});
	});

	describe('handleDeleteColumnItem', () => {
		it('removes an item from a column', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			ctx.handleDeleteColumnItem('cols-1', 0, 'col-item-1');
			const content = ctx.canvasBlocks.value[0]!.content as ColumnsBlockContent;
			expect(content.columns[0]).toHaveLength(0);
		});

		it('calls onColumnItemDeleted callback', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			ctx.handleDeleteColumnItem('cols-1', 0, 'col-item-1');
			expect(ctx.onColumnItemDeleted).toHaveBeenCalledWith('col-item-1');
		});

		it('does nothing for nonexistent item', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			ctx.handleDeleteColumnItem('cols-1', 0, 'nonexistent');
			const content = ctx.canvasBlocks.value[0]!.content as ColumnsBlockContent;
			expect(content.columns[0]).toHaveLength(1);
			expect(ctx.onColumnItemDeleted).not.toHaveBeenCalled();
		});
	});

	describe('handleDuplicateColumnItem', () => {
		it('duplicates a column item after the original', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			const newItem = ctx.handleDuplicateColumnItem('cols-1', 0, 'col-item-1');
			expect(newItem).not.toBeNull();
			const content = ctx.canvasBlocks.value[0]!.content as ColumnsBlockContent;
			expect(content.columns[0]).toHaveLength(2);
			expect(content.columns[0]![1]!.id).toBe(newItem!.id);
		});

		it('returns null for nonexistent item', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			const result = ctx.handleDuplicateColumnItem('cols-1', 0, 'nonexistent');
			expect(result).toBeNull();
		});

		it('generates a new ID for the duplicate', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			const newItem = ctx.handleDuplicateColumnItem('cols-1', 0, 'col-item-1');
			expect(newItem!.id).not.toBe('col-item-1');
		});
	});

	describe('handleColumnCountChange', () => {
		it('adds new empty columns when increasing count', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			ctx.handleColumnCountChange('cols-1', 3);
			const content = ctx.canvasBlocks.value[0]!.content as ColumnsBlockContent;
			expect(content.columnCount).toBe(3);
			expect(content.columns).toHaveLength(3);
			expect(content.columns[2]).toHaveLength(0);
		});

		it('moves items from removed columns to last column', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			// Block starts with 2 columns, col[1] has col-item-2
			ctx.handleColumnCountChange('cols-1', 1);
			const content = ctx.canvasBlocks.value[0]!.content as ColumnsBlockContent;
			expect(content.columnCount).toBe(1);
			expect(content.columns).toHaveLength(1);
			// Items from column 1 should have been moved to column 0
			expect(content.columns[0]!.length).toBe(2); // original + moved
		});

		it('does nothing when count is the same', () => {
			const ctx = setup([makeColumnsBlock('cols-1')]);
			const content = ctx.canvasBlocks.value[0]!.content as ColumnsBlockContent;
			const originalColumns = JSON.stringify(content.columns);
			ctx.handleColumnCountChange('cols-1', 2);
			expect(JSON.stringify(content.columns)).toBe(originalColumns);
		});

		it('does nothing for non-columns block', () => {
			const ctx = setup([makeTextBlock('b1')]);
			ctx.handleColumnCountChange('b1', 3);
			// Should not throw, just no-op
			expect(ctx.canvasBlocks.value[0]!.type).toBe('text');
		});
	});

	describe('handleDeleteContainerItem', () => {
		it('deletes a top-level container item', () => {
			const ctx = setup([makeContainerBlock('c1')]);
			ctx.handleDeleteContainerItem('c1', 'citem-1');
			const content = ctx.canvasBlocks.value[0]!.content as ContainerBlockContent;
			expect(content.items).toHaveLength(1);
			expect(content.items[0]!.id).toBe('citem-2');
		});

		it('deletes a nested container item recursively', () => {
			const ctx = setup([makeContainerBlock('c1')]);
			ctx.handleDeleteContainerItem('c1', 'nested-1');
			const content = ctx.canvasBlocks.value[0]!.content as ContainerBlockContent;
			const nestedContainer = content.items[1]!.content as ContainerBlockContent;
			expect(nestedContainer.items).toHaveLength(0);
		});

		it('calls onContainerItemDeleted callback', () => {
			const ctx = setup([makeContainerBlock('c1')]);
			ctx.handleDeleteContainerItem('c1', 'citem-1');
			expect(ctx.onContainerItemDeleted).toHaveBeenCalledWith('citem-1');
		});

		it('does nothing for nonexistent item', () => {
			const ctx = setup([makeContainerBlock('c1')]);
			ctx.handleDeleteContainerItem('c1', 'nonexistent');
			const content = ctx.canvasBlocks.value[0]!.content as ContainerBlockContent;
			expect(content.items).toHaveLength(2);
		});

		it('does nothing for non-container block type', () => {
			const ctx = setup([makeTextBlock('b1')]);
			ctx.handleDeleteContainerItem('b1', 'some-id');
			// Should not throw
			expect(ctx.canvasBlocks.value).toHaveLength(1);
		});
	});

	describe('handleDuplicateContainerItem', () => {
		it('duplicates a container item after the original', () => {
			const ctx = setup([makeContainerBlock('c1')]);
			const newItem = ctx.handleDuplicateContainerItem('c1', 'citem-1');
			expect(newItem).not.toBeNull();
			const content = ctx.canvasBlocks.value[0]!.content as ContainerBlockContent;
			expect(content.items).toHaveLength(3);
			expect(content.items[1]!.id).toBe(newItem!.id);
		});

		it('duplicates a nested container item', () => {
			const ctx = setup([makeContainerBlock('c1')]);
			const newItem = ctx.handleDuplicateContainerItem('c1', 'nested-1');
			expect(newItem).not.toBeNull();
			const content = ctx.canvasBlocks.value[0]!.content as ContainerBlockContent;
			const nestedContainer = content.items[1]!.content as ContainerBlockContent;
			expect(nestedContainer.items).toHaveLength(2);
		});

		it('generates new IDs for duplicated items', () => {
			const ctx = setup([makeContainerBlock('c1')]);
			const newItem = ctx.handleDuplicateContainerItem('c1', 'citem-1');
			expect(newItem!.id).not.toBe('citem-1');
		});

		it('returns null for nonexistent item', () => {
			const ctx = setup([makeContainerBlock('c1')]);
			const result = ctx.handleDuplicateContainerItem('c1', 'nonexistent');
			expect(result).toBeNull();
		});

		it('returns null for non-container block', () => {
			const ctx = setup([makeTextBlock('b1')]);
			const result = ctx.handleDuplicateContainerItem('b1', 'some-id');
			expect(result).toBeNull();
		});
	});
});
