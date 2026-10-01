import { type Ref } from 'vue';
import type {
	EditorBlock,
	BlockType,
	ColumnsBlockContent,
	ColumnItem,
	TextBlockContent,
	EmailTheme,
} from '../types';
import {
	generateId,
	createDefaultContent,
	createDefaultColumnItemContent,
	cloneWithFreshIds,
	locateBlock,
	locateWithin,
} from '../utils';
import { defaultPadding, defaultMargin } from '../defaults';

export interface UseBlockManagementOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	selectedBlockId: Ref<string | null>;
	theme: Ref<Required<EmailTheme>>;
	onBlockDeleted?: (blockId: string) => void;
	onColumnItemDeleted?: (itemId: string) => void;
	onContainerItemDeleted?: (itemId: string) => void;
	/**
	 * Called after an edit made in place inside a block (a column or container
	 * item added, removed or duplicated, the column count changed), which a
	 * watcher on the root array cannot see. EmailBuilder bumps its block-tree
	 * version here (see useBlockTreeVersion).
	 */
	onTreeMutated?: () => void;
}

export interface UseBlockManagementReturn {
	// Block operations
	handleAddBlock: (type: BlockType, afterBlockId?: string) => EditorBlock;
	handleAddHeadingBlock: (level: 1 | 2 | 3, afterBlockId?: string) => EditorBlock;
	handleDeleteBlock: (blockId: string) => void;
	handleDuplicateBlock: (blockId: string) => void;

	// Column item operations
	handleAddItemToColumn: (
		blockId: string,
		columnIndex: number,
		itemType: ColumnItem['type']
	) => ColumnItem | null;

	// Column management
	handleColumnCountChange: (blockId: string, newCount: 1 | 2 | 3) => void;

	// Nested item operations, for an item at any depth below `blockId` (a
	// columns, container or hero Block, itself a root or nested)
	handleDeleteNestedItem: (blockId: string, itemId: string) => void;
	handleDuplicateNestedItem: (blockId: string, itemId: string) => EditorBlock | null;
}

/**
 * Composable for managing block CRUD operations
 */
export function useBlockManagement(options: UseBlockManagementOptions): UseBlockManagementReturn {
	const {
		canvasBlocks,
		selectedBlockId,
		theme,
		onBlockDeleted,
		onColumnItemDeleted,
		onContainerItemDeleted,
		onTreeMutated,
	} = options;

	// Insert a block after a specific block, or append to end
	function insertBlock(newBlock: EditorBlock, afterBlockId?: string) {
		if (afterBlockId) {
			const idx = canvasBlocks.value.findIndex((b) => b.id === afterBlockId);
			if (idx !== -1) {
				canvasBlocks.value.splice(idx + 1, 0, newBlock);
				selectedBlockId.value = newBlock.id;
				return;
			}
		}
		canvasBlocks.value.push(newBlock);
		selectedBlockId.value = newBlock.id;
	}

	// Add a new block
	const handleAddBlock = (type: BlockType, afterBlockId?: string): EditorBlock => {
		const newBlock = {
			id: generateId(),
			type,
			content: createDefaultContent(type, theme.value),
		} as EditorBlock;
		insertBlock(newBlock, afterBlockId);
		return newBlock;
	};

	// Add a heading block
	const handleAddHeadingBlock = (level: 1 | 2 | 3, afterBlockId?: string): EditorBlock => {
		const headingText = level === 1 ? 'Heading 1' : level === 2 ? 'Heading 2' : 'Heading 3';
		const blockType = `h${level}` as 'h1' | 'h2' | 'h3';
		const newBlock: EditorBlock = {
			id: generateId(),
			type: 'text',
			content: {
				html: headingText,
				blockType,
				fontSize: level === 1 ? 32 : level === 2 ? 24 : 20,
				textColor: '#374151',
				lineHeight: 1.3,
				...defaultPadding,
				...defaultMargin,
			} as TextBlockContent,
		};
		insertBlock(newBlock, afterBlockId);
		return newBlock;
	};

	// Delete a block
	const handleDeleteBlock = (blockId: string) => {
		const index = canvasBlocks.value.findIndex((b) => b.id === blockId);
		if (index !== -1) {
			const block = canvasBlocks.value[index];

			// Clean up column item editors if this is a columns block
			if (block?.type === 'columns') {
				const content = block.content as ColumnsBlockContent;
				content.columns.forEach((column) => {
					column.forEach((item: ColumnItem) => {
						onColumnItemDeleted?.(item.id);
					});
				});
			}

			// Notify about block deletion (for editor cleanup)
			onBlockDeleted?.(blockId);

			canvasBlocks.value.splice(index, 1);
			if (selectedBlockId.value === blockId) {
				selectedBlockId.value = null;
			}
		}
	};

	// Duplicate a block. Every nested item gets a fresh id too, so an edit or a
	// translation overlay keyed by a child id reaches one copy only. The copy is
	// not linked: it carries no savedBlockRef.
	const handleDuplicateBlock = (blockId: string) => {
		const index = canvasBlocks.value.findIndex((b) => b.id === blockId);
		const block = canvasBlocks.value[index];
		if (!block) return;

		const newBlock = cloneWithFreshIds({
			id: block.id,
			type: block.type,
			content: block.content,
		} as EditorBlock);

		// Insert after the current block
		canvasBlocks.value.splice(index + 1, 0, newBlock);
		selectedBlockId.value = newBlock.id;
	};

	// A columns Block at any depth (a root, or nested in a container or hero).
	const findColumnsBlock = (blockId: string): ColumnsBlockContent | null => {
		const block = locateBlock(canvasBlocks.value, blockId)?.block;
		return block?.type === 'columns' ? (block.content as ColumnsBlockContent) : null;
	};

	// Add an item to a column
	const handleAddItemToColumn = (
		blockId: string,
		columnIndex: number,
		itemType: ColumnItem['type']
	): ColumnItem | null => {
		const content = findColumnsBlock(blockId);
		const column = content?.columns[columnIndex];
		if (!column) return null;

		const newItem: ColumnItem = {
			id: generateId(),
			type: itemType,
			content: createDefaultColumnItemContent(itemType, theme.value),
		};

		column.push(newItem);
		onTreeMutated?.();
		return newItem;
	};

	// Change column count
	const handleColumnCountChange = (blockId: string, newCount: 1 | 2 | 3) => {
		const content = findColumnsBlock(blockId);
		if (!content) return;

		const currentCount = content.columnCount;

		if (newCount === currentCount) return;

		content.columnCount = newCount;

		// Adjust columns array
		if (newCount > currentCount) {
			// Add new columns
			for (let i = currentCount; i < newCount; i++) {
				content.columns.push([]);
			}
		} else {
			// Remove extra columns (keep items from removed columns)
			const removedItems: ColumnItem[] = [];
			for (let i = newCount; i < currentCount; i++) {
				const column = content.columns[i];
				if (column) {
					removedItems.push(...column);
				}
			}
			content.columns = content.columns.slice(0, newCount);
			// Add removed items to the last column
			if (removedItems.length > 0) {
				const lastColumn = content.columns[newCount - 1];
				if (lastColumn) {
					lastColumn.push(...removedItems);
				}
			}
		}
		onTreeMutated?.();
	};

	// Delete a nested item anywhere below `blockId`: a column of a columns
	// Block, the items of a container or hero, or any composite nested in them.
	const handleDeleteNestedItem = (blockId: string, itemId: string) => {
		const location = locateWithin(canvasBlocks.value, blockId, itemId);
		if (!location) return;
		location.list.splice(location.index, 1);
		if (location.parent?.type === 'columns') onColumnItemDeleted?.(itemId);
		else onContainerItemDeleted?.(itemId);
		onTreeMutated?.();
	};

	// Duplicate a nested item anywhere below `blockId`, right after the original.
	// The copy and everything inside it get fresh ids.
	const handleDuplicateNestedItem = (blockId: string, itemId: string): EditorBlock | null => {
		const location = locateWithin(canvasBlocks.value, blockId, itemId);
		if (!location) return null;
		const newItem = cloneWithFreshIds(location.block);
		location.list.splice(location.index + 1, 0, newItem);
		onTreeMutated?.();
		return newItem;
	};

	return {
		handleAddBlock,
		handleAddHeadingBlock,
		handleDeleteBlock,
		handleDuplicateBlock,
		handleAddItemToColumn,
		handleColumnCountChange,
		handleDeleteNestedItem,
		handleDuplicateNestedItem,
	};
}
