import type { ComputedRef, Ref } from 'vue';
import type {
	BlockType,
	ColumnItem,
	ContainerBlockContent,
	ContainerItem,
	EditorBlock,
	EmailTheme,
	HeroBlockContent,
} from '../../types';
import { createBlock } from '../../utils/blocks';
import { locateBlock, replaceBlockInTree } from '../../utils/blockTree';
import { moveBlock, type MoveDirection } from '../../utils/blockMove';
import { generateId } from '../../utils/id';
import { setByPath } from '../../utils/propertyPath';
import type { UseBlockManagementReturn } from '../useBlockManagement';
import type { UseLinkedBlocksReturn } from '../useLinkedBlocks';
import type { useBuilderSelection } from './useBuilderSelection';

interface UseBuilderBlockCommandsOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	theme: ComputedRef<Required<EmailTheme>>;
	selection: ReturnType<typeof useBuilderSelection>;
	linkedBlocks: Pick<UseLinkedBlocksReturn, 'isLinkedBlock' | 'getLinkedGroupByBlockId'>;
	blockManagement: Pick<
		UseBlockManagementReturn,
		| 'handleDeleteBlock'
		| 'handleDuplicateBlock'
		| 'handleDuplicateNestedItem'
		| 'handleAddItemToColumn'
		| 'handleDeleteNestedItem'
	>;
}

/**
 * Commands on existing Blocks, a root or a nested item at any depth: property
 * writes, delete, duplicate and move of the active Block, and the child-panel
 * commands of the active composite. Content inside a linked Block or a Block
 * someone else holds is left alone.
 */
export function useBuilderBlockCommands({
	canvasBlocks,
	theme,
	selection,
	linkedBlocks,
	blockManagement,
}: UseBuilderBlockCommandsOptions) {
	const { blockState, activeBlock, selectedNestedItemId, selectedRootId, isEditable } = selection;
	const {
		selectedColumnItemId,
		selectedContainerItemId,
		clearSelection: clearBlockSelection,
	} = blockState;
	const { isLinkedBlock, getLinkedGroupByBlockId } = linkedBlocks;
	const {
		handleDeleteBlock,
		handleDuplicateBlock,
		handleDuplicateNestedItem,
		handleAddItemToColumn,
		handleDeleteNestedItem,
	} = blockManagement;

	/**
	 * Write one property of a Block, a root or a nested item at any depth. The
	 * root and the composites on the path are replaced rather than mutated, so the
	 * edit lands as one write to the root array. A dotted key (`labels.days`)
	 * writes a nested property.
	 */
	function handleBlockPropertyUpdate(blockId: string, key: string, value: unknown) {
		if (!isEditable(blockId)) return;
		const replaced = replaceBlockInTree(
			canvasBlocks.value,
			blockId,
			(block) =>
				({
					...block,
					content: (key.includes('.')
						? setByPath(block.content as unknown as Record<string, unknown>, key, value)
						: { ...block.content, [key]: value }) as unknown as EditorBlock['content'],
				}) as EditorBlock,
			selectedRootId.value
		);
		if (replaced) canvasBlocks.value[replaced.rootIndex] = replaced.root;
	}

	function handleDeleteActiveBlock() {
		if (!activeBlock.value) return;
		const blockId = activeBlock.value.id;

		// A nested item, at any depth
		const scope =
			blockState.selectedColumnContext.value ?? blockState.selectedContainerContext.value;
		if (selectedNestedItemId.value && scope) {
			if (isEditable(scope.blockId)) handleDeleteNestedItem(scope.blockId, blockId);
			clearBlockSelection();
		} else {
			// If this block is part of a linked group, delete all blocks in the group
			const group = getLinkedGroupByBlockId(blockId);
			if (group) {
				// Delete in reverse index order to keep indices stable
				for (const idx of [...group.blockIndices].reverse()) {
					const block = canvasBlocks.value[idx];
					if (block) {
						handleDeleteBlock(block.id);
					}
				}
			} else {
				handleDeleteBlock(blockId);
			}
		}
	}

	function handleDuplicateActiveBlock() {
		if (!activeBlock.value) return;
		const blockId = activeBlock.value.id;

		// A nested item is copied next to itself, at any depth. The canonical
		// handler deep-clones it and gives it and everything inside it fresh ids.
		const scope =
			blockState.selectedColumnContext.value ?? blockState.selectedContainerContext.value;
		if (selectedNestedItemId.value && scope) {
			if (isEditable(scope.blockId)) handleDuplicateNestedItem(scope.blockId, blockId);
		} else {
			handleDuplicateBlock(blockId);
		}
	}

	function handleMoveBlock(direction: MoveDirection) {
		if (!activeBlock.value) return;

		// One whole-array write, whatever level the moved item lives at, so the
		// history watcher records the move as a single undoable step. Items inside
		// a linked Block keep their order.
		if (selectedNestedItemId.value && selectedRootId.value && isLinkedBlock(selectedRootId.value))
			return;
		const moved = moveBlock(
			canvasBlocks.value,
			{
				itemId: activeBlock.value.id,
				column: selectedColumnItemId.value ? blockState.selectedColumnContext.value : null,
				container: selectedContainerItemId.value ? blockState.selectedContainerContext.value : null,
			},
			direction
		);
		if (moved) canvasBlocks.value = moved;
	}

	// Child-panel commands for the active composite, which may itself be nested.
	// Where a new child goes and which defaults it gets is the composite's
	// placement: column items take the compact column defaults.
	function handleAddChild(blockId: string, childType: BlockType) {
		if (!isEditable(blockId)) return;
		const block = locateBlock(canvasBlocks.value, blockId, selectedRootId.value)?.block;
		if (!block) return;

		if (block.type === 'columns') {
			// Add to first column by default
			handleAddItemToColumn(blockId, 0, childType as ColumnItem['type']);
		} else if (block.type === 'container' || block.type === 'hero') {
			const content = block.content as ContainerBlockContent | HeroBlockContent;
			const newItem: ContainerItem = {
				id: generateId(),
				type: childType as ContainerItem['type'],
				content: createBlock(childType, theme.value).content as ContainerItem['content'],
			};
			const updatedItems = [...content.items, newItem];
			handleBlockPropertyUpdate(blockId, 'items', updatedItems);
		}
	}

	function handleRemoveChild(blockId: string, childId: string) {
		if (isEditable(blockId)) handleDeleteNestedItem(blockId, childId);
	}

	function handleSelectChild(blockId: string, childId: string) {
		selection.selectNestedItem(blockId, childId);
	}

	function handleUpdateChildren(blockId: string, children: unknown[]) {
		const block = locateBlock(canvasBlocks.value, blockId, selectedRootId.value)?.block;
		if (!block) return;
		const key = block.type === 'columns' ? 'columns' : 'items';
		handleBlockPropertyUpdate(blockId, key, children);
	}

	function handleReorderChildren(blockId: string, children: unknown[]) {
		handleBlockPropertyUpdate(blockId, 'items', children);
	}

	// Toolbar event handlers
	function handleToolbarUpdate(blockId: string, key: string, value: unknown) {
		handleBlockPropertyUpdate(blockId, key, value);
	}

	function handleToolbarDelete() {
		handleDeleteActiveBlock();
	}

	function handleToolbarDuplicate() {
		handleDuplicateActiveBlock();
	}

	// The inline editor removes a text Block it closes empty, root or nested.
	function handleDeleteInlineEditedBlock(blockId: string) {
		const location = locateBlock(canvasBlocks.value, blockId, selectedRootId.value);
		if (!location) return;
		if (!location.parent) {
			handleDeleteBlock(blockId);
			return;
		}
		if (!isEditable(blockId)) return;
		handleDeleteNestedItem(location.parent.id, blockId);
		if (selectedNestedItemId.value === blockId) clearBlockSelection();
	}

	return {
		handleBlockPropertyUpdate,
		handleDeleteActiveBlock,
		handleDuplicateActiveBlock,
		handleMoveBlock,
		handleAddChild,
		handleRemoveChild,
		handleSelectChild,
		handleUpdateChildren,
		handleReorderChildren,
		handleToolbarUpdate,
		handleToolbarDelete,
		handleToolbarDuplicate,
		handleDeleteInlineEditedBlock,
	};
}
