import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import { useBlockState } from '../useBlockState';
import type { EditorBlock, ColumnsBlockContent, ContainerBlockContent } from '../../types';

// Ensure block definitions are registered
import '../../registry';

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
				[
					{ id: 'col-item-1', type: 'text', content: { html: 'Col 1' } },
					{ id: 'col-item-2', type: 'image', content: { src: '' } },
				],
				[
					{ id: 'col-item-3', type: 'button', content: { text: 'Click' } },
				],
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
				{
					id: 'container-item-1',
					type: 'text',
					content: { html: 'Inside container' },
				},
				{
					id: 'container-item-2',
					type: 'container',
					content: {
						items: [
							{
								id: 'nested-item-1',
								type: 'text',
								content: { html: 'Nested text' },
							},
						],
						backgroundColor: '#fff',
						paddingTop: 16,
						paddingRight: 16,
						paddingBottom: 16,
						paddingLeft: 16,
						paddingLinked: true,
						marginTop: 0,
						marginRight: 0,
						marginBottom: 0,
						marginLeft: 0,
					} as ContainerBlockContent,
				},
			],
			backgroundColor: '#f0f0f0',
			paddingTop: 16,
			paddingRight: 16,
			paddingBottom: 16,
			paddingLeft: 16,
			paddingLinked: true,
			marginTop: 0,
			marginRight: 0,
			marginBottom: 0,
			marginLeft: 0,
		} as ContainerBlockContent,
	};
}

describe('useBlockState', () => {
	function setup(blocks: EditorBlock[] = []) {
		const canvasBlocks = ref(blocks);
		return useBlockState({ canvasBlocks });
	}

	describe('initial state', () => {
		it('starts with no selection', () => {
			const state = setup();
			expect(state.selectedBlockId.value).toBeNull();
			expect(state.selectedBlock.value).toBeNull();
			expect(state.selectedColumnItemId.value).toBeNull();
			expect(state.selectedColumnContext.value).toBeNull();
			expect(state.selectedContainerItemId.value).toBeNull();
			expect(state.selectedContainerContext.value).toBeNull();
		});

		it('starts with empty block elements map', () => {
			const state = setup();
			expect(state.blockElements.value.size).toBe(0);
		});
	});

	describe('handleSelectBlock', () => {
		it('selects a block by ID', () => {
			const block = makeTextBlock('block-1');
			const state = setup([block]);
			state.handleSelectBlock('block-1');
			expect(state.selectedBlockId.value).toBe('block-1');
			expect(state.selectedBlock.value).toEqual(block);
		});

		it('clears column and container selections', () => {
			const state = setup([makeColumnsBlock('cols-1')]);
			// First select a column item
			state.handleSelectColumnItem('cols-1', 0, 'col-item-1');
			expect(state.selectedColumnItemId.value).toBe('col-item-1');

			// Now select a block
			state.handleSelectBlock('cols-1');
			expect(state.selectedBlockId.value).toBe('cols-1');
			expect(state.selectedColumnItemId.value).toBeNull();
			expect(state.selectedColumnContext.value).toBeNull();
			expect(state.selectedContainerItemId.value).toBeNull();
			expect(state.selectedContainerContext.value).toBeNull();
		});
	});

	describe('handleSelectColumnItem', () => {
		it('selects a column item with context', () => {
			const state = setup([makeColumnsBlock('cols-1')]);
			state.handleSelectColumnItem('cols-1', 0, 'col-item-1');

			expect(state.selectedColumnItemId.value).toBe('col-item-1');
			expect(state.selectedColumnContext.value).toEqual({
				blockId: 'cols-1',
				columnIndex: 0,
			});
		});

		it('clears block and container selections', () => {
			const state = setup([makeColumnsBlock('cols-1'), makeTextBlock('text-1')]);
			state.handleSelectBlock('text-1');
			expect(state.selectedBlockId.value).toBe('text-1');

			state.handleSelectColumnItem('cols-1', 0, 'col-item-1');
			expect(state.selectedBlockId.value).toBeNull();
			expect(state.selectedContainerItemId.value).toBeNull();
		});

		it('resolves selectedColumnItem computed', () => {
			const state = setup([makeColumnsBlock('cols-1')]);
			state.handleSelectColumnItem('cols-1', 0, 'col-item-1');
			const item = state.selectedColumnItem.value;
			expect(item).not.toBeNull();
			expect(item!.id).toBe('col-item-1');
			expect(item!.type).toBe('text');
		});

		it('returns null for selectedColumnItem when column item not found', () => {
			const state = setup([makeColumnsBlock('cols-1')]);
			state.handleSelectColumnItem('cols-1', 0, 'nonexistent');
			expect(state.selectedColumnItem.value).toBeNull();
		});
	});

	describe('handleSelectColumnArea', () => {
		it('selects the block and clears column/container selections', () => {
			const state = setup([makeColumnsBlock('cols-1')]);
			state.handleSelectColumnItem('cols-1', 0, 'col-item-1');
			state.handleSelectColumnArea('cols-1');

			expect(state.selectedBlockId.value).toBe('cols-1');
			expect(state.selectedColumnItemId.value).toBeNull();
			expect(state.selectedColumnContext.value).toBeNull();
		});
	});

	describe('handleSelectContainerItem', () => {
		it('selects a container item with context', () => {
			const state = setup([makeContainerBlock('container-1')]);
			state.handleSelectContainerItem('container-1', 'container-item-1');

			expect(state.selectedContainerItemId.value).toBe('container-item-1');
			expect(state.selectedContainerContext.value).toEqual({
				blockId: 'container-1',
			});
		});

		it('clears block and column selections', () => {
			const state = setup([makeContainerBlock('container-1'), makeTextBlock('text-1')]);
			state.handleSelectBlock('text-1');
			state.handleSelectContainerItem('container-1', 'container-item-1');

			expect(state.selectedBlockId.value).toBeNull();
			expect(state.selectedColumnItemId.value).toBeNull();
		});

		it('resolves nested container items recursively', () => {
			const state = setup([makeContainerBlock('container-1')]);
			state.handleSelectContainerItem('container-1', 'nested-item-1');
			const item = state.selectedContainerItem.value;
			expect(item).not.toBeNull();
			expect(item!.id).toBe('nested-item-1');
		});
	});

	describe('handleSelectContainerArea', () => {
		it('selects the block and clears sub-selections', () => {
			const state = setup([makeContainerBlock('container-1')]);
			state.handleSelectContainerItem('container-1', 'container-item-1');
			state.handleSelectContainerArea('container-1');

			expect(state.selectedBlockId.value).toBe('container-1');
			expect(state.selectedContainerItemId.value).toBeNull();
			expect(state.selectedContainerContext.value).toBeNull();
		});
	});

	describe('clearSelection', () => {
		it('clears all selections', () => {
			const state = setup([makeTextBlock('text-1')]);
			state.handleSelectBlock('text-1');
			state.clearSelection();

			expect(state.selectedBlockId.value).toBeNull();
			expect(state.selectedBlock.value).toBeNull();
			expect(state.selectedColumnItemId.value).toBeNull();
			expect(state.selectedColumnContext.value).toBeNull();
			expect(state.selectedContainerItemId.value).toBeNull();
			expect(state.selectedContainerContext.value).toBeNull();
		});
	});

	describe('setBlockElement', () => {
		it('registers a block element', () => {
			const state = setup([makeTextBlock('text-1')]);
			const el = {} as HTMLElement;
			state.setBlockElement('text-1', el);
			expect(state.blockElements.value.has('text-1')).toBe(true);
		});

		it('ignores null to prevent reactive churn from ref cleanup', () => {
			const state = setup([makeTextBlock('text-1')]);
			const el = {} as HTMLElement;
			state.setBlockElement('text-1', el);
			state.setBlockElement('text-1', null);
			// null is intentionally ignored to break the recursive update cycle
			expect(state.blockElements.value.has('text-1')).toBe(true);
		});

		it('selectedBlockElement reflects registered element', () => {
			const state = setup([makeTextBlock('text-1')]);
			const el = {} as HTMLElement;
			state.setBlockElement('text-1', el);
			state.handleSelectBlock('text-1');
			expect(state.selectedBlockElement.value).not.toBeNull();
		});

		it('selectedBlockElement is null when no element registered', () => {
			const state = setup([makeTextBlock('text-1')]);
			state.handleSelectBlock('text-1');
			expect(state.selectedBlockElement.value).toBeNull();
		});
	});

	describe('edge cases', () => {
		it('selectedBlock is null when block ID not in canvasBlocks', () => {
			const state = setup([makeTextBlock('text-1')]);
			state.handleSelectBlock('nonexistent');
			expect(state.selectedBlock.value).toBeNull();
		});

		it('selectedColumnItem returns null for non-columns block', () => {
			const state = setup([makeTextBlock('text-1')]);
			state.selectedColumnItemId.value = 'some-id';
			state.selectedColumnContext.value = { blockId: 'text-1', columnIndex: 0 };
			expect(state.selectedColumnItem.value).toBeNull();
		});

		it('selectedContainerItem returns null for non-container block', () => {
			const state = setup([makeTextBlock('text-1')]);
			state.selectedContainerItemId.value = 'some-id';
			state.selectedContainerContext.value = { blockId: 'text-1' };
			expect(state.selectedContainerItem.value).toBeNull();
		});
	});
});
