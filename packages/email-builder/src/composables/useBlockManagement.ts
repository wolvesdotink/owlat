import { type Ref } from 'vue';
import type {
	EditorBlock,
	BlockType,
	ColumnsBlockContent,
	ColumnItem,
	ContainerBlockContent,
	ContainerItem,
	HeroBlockContent,
	TextBlockContent,
	EmailTheme,
} from '../types';
import {
	generateId,
	createDefaultContent,
	createDefaultColumnItemContent,
	regenerateContainerItemIds,
} from '../utils';
import { defaultPadding, defaultMargin } from '../defaults';

export interface UseBlockManagementOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	selectedBlockId: Ref<string | null>;
	theme: Ref<Required<EmailTheme>>;
	onBlockDeleted?: (blockId: string) => void;
	onColumnItemDeleted?: (itemId: string) => void;
	onContainerItemDeleted?: (itemId: string) => void;
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
	handleDeleteColumnItem: (blockId: string, columnIndex: number, itemId: string) => void;
	handleDuplicateColumnItem: (
		blockId: string,
		columnIndex: number,
		itemId: string
	) => ColumnItem | null;

	// Column management
	handleColumnCountChange: (blockId: string, newCount: 1 | 2 | 3) => void;

	// Container item operations
	handleDeleteContainerItem: (blockId: string, itemId: string) => void;
	handleDuplicateContainerItem: (blockId: string, itemId: string) => ContainerItem | null;
}

/**
 * Composable for managing block CRUD operations
 */
export function useBlockManagement(options: UseBlockManagementOptions): UseBlockManagementReturn {
	const { canvasBlocks, selectedBlockId, theme, onBlockDeleted, onColumnItemDeleted, onContainerItemDeleted } = options;

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

	// Duplicate a block
	const handleDuplicateBlock = (blockId: string) => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block) return;

		const index = canvasBlocks.value.findIndex((b) => b.id === blockId);
		const newBlock: EditorBlock = {
			id: generateId(),
			type: block.type,
			content: JSON.parse(JSON.stringify(block.content)),
		};

		// Insert after the current block
		canvasBlocks.value.splice(index + 1, 0, newBlock);
		selectedBlockId.value = newBlock.id;
	};

	// Add an item to a column
	const handleAddItemToColumn = (
		blockId: string,
		columnIndex: number,
		itemType: ColumnItem['type']
	): ColumnItem | null => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block || block.type !== 'columns') return null;

		const content = block.content as ColumnsBlockContent;
		const column = content.columns[columnIndex];
		if (!column) return null;

		const newItem: ColumnItem = {
			id: generateId(),
			type: itemType,
			content: createDefaultColumnItemContent(itemType, theme.value),
		};

		column.push(newItem);
		return newItem;
	};

	// Delete a column item
	const handleDeleteColumnItem = (blockId: string, columnIndex: number, itemId: string) => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block || block.type !== 'columns') return;

		const content = block.content as ColumnsBlockContent;
		const column = content.columns[columnIndex];
		if (!column) return;

		const itemIndex = column.findIndex((item: ColumnItem) => item.id === itemId);
		if (itemIndex !== -1) {
			column.splice(itemIndex, 1);
			onColumnItemDeleted?.(itemId);
		}
	};

	// Duplicate a column item
	const handleDuplicateColumnItem = (
		blockId: string,
		columnIndex: number,
		itemId: string
	): ColumnItem | null => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block || block.type !== 'columns') return null;

		const content = block.content as ColumnsBlockContent;
		const column = content.columns[columnIndex];
		if (!column) return null;

		const itemIndex = column.findIndex((item: ColumnItem) => item.id === itemId);
		if (itemIndex === -1) return null;

		const item = column[itemIndex];
		if (!item) return null;

		const newItem: ColumnItem = {
			id: generateId(),
			type: item.type,
			content: JSON.parse(JSON.stringify(item.content)),
		};

		// Insert after the current item
		column.splice(itemIndex + 1, 0, newItem);
		return newItem;
	};

	// Change column count
	const handleColumnCountChange = (blockId: string, newCount: 1 | 2 | 3) => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block || block.type !== 'columns') return;

		const content = block.content as ColumnsBlockContent;
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
	};

	// Helper to recursively find and delete container item
	const findAndDeleteContainerItem = (
		items: ContainerItem[],
		itemId: string
	): boolean => {
		const itemIndex = items.findIndex((item) => item.id === itemId);
		if (itemIndex !== -1) {
			items.splice(itemIndex, 1);
			onContainerItemDeleted?.(itemId);
			return true;
		}
		// Recursively search nested containers
		for (const item of items) {
			if (item.type === 'container') {
				const containerContent = item.content as ContainerBlockContent;
				if (findAndDeleteContainerItem(containerContent.items, itemId)) {
					return true;
				}
			}
		}
		return false;
	};

	// Delete a container item (supports both container and hero blocks)
	const handleDeleteContainerItem = (blockId: string, itemId: string) => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block) return;

		let items: ContainerItem[];
		if (block.type === 'container') {
			items = (block.content as ContainerBlockContent).items;
		} else if (block.type === 'hero') {
			items = (block.content as HeroBlockContent).items;
		} else {
			return;
		}

		findAndDeleteContainerItem(items, itemId);
	};

	// Helper to recursively find and duplicate container item
	const findAndDuplicateContainerItem = (
		items: ContainerItem[],
		itemId: string
	): ContainerItem | null => {
		const itemIndex = items.findIndex((item) => item.id === itemId);
		if (itemIndex !== -1) {
			const item = items[itemIndex];
			if (!item) return null;

			const newItem: ContainerItem = {
				id: generateId(),
				type: item.type,
				content: JSON.parse(JSON.stringify(item.content)),
			};

			// Regenerate IDs for nested containers if any
			if (newItem.type === 'container') {
				const containerContent = newItem.content as ContainerBlockContent;
				regenerateContainerItemIds(containerContent.items);
			}

			// Insert after the current item
			items.splice(itemIndex + 1, 0, newItem);
			return newItem;
		}
		// Recursively search nested containers
		for (const item of items) {
			if (item.type === 'container') {
				const containerContent = item.content as ContainerBlockContent;
				const result = findAndDuplicateContainerItem(containerContent.items, itemId);
				if (result) return result;
			}
		}
		return null;
	};

	// Duplicate a container item (supports both container and hero blocks)
	const handleDuplicateContainerItem = (blockId: string, itemId: string): ContainerItem | null => {
		const block = canvasBlocks.value.find((b) => b.id === blockId);
		if (!block) return null;

		let items: ContainerItem[];
		if (block.type === 'container') {
			items = (block.content as ContainerBlockContent).items;
		} else if (block.type === 'hero') {
			items = (block.content as HeroBlockContent).items;
		} else {
			return null;
		}

		return findAndDuplicateContainerItem(items, itemId);
	};

	return {
		handleAddBlock,
		handleAddHeadingBlock,
		handleDeleteBlock,
		handleDuplicateBlock,
		handleAddItemToColumn,
		handleDeleteColumnItem,
		handleDuplicateColumnItem,
		handleColumnCountChange,
		handleDeleteContainerItem,
		handleDuplicateContainerItem,
	};
}
