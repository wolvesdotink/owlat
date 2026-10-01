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
import type { BlockSlot } from '../utils/blockTree';
import { childBlockLists } from '@owlat/shared/blockTree';
import { editorModuleFor } from '../registry';
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
	handleInsertBlockAtSlot: (
		type: BlockType,
		slot: BlockSlot,
		content?: (defaults: EditorBlock['content']) => EditorBlock['content']
	) => { block: EditorBlock; parentId: string | null } | null;
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

/** The content a slash-menu heading command inserts, at any placement. */
export function headingContent(level: 1 | 2 | 3): TextBlockContent {
	return {
		html: level === 1 ? 'Heading 1' : level === 2 ? 'Heading 2' : 'Heading 3',
		blockType: `h${level}`,
		fontSize: level === 1 ? 32 : level === 2 ? 24 : 20,
		textColor: '#374151',
		lineHeight: 1.3,
		...defaultPadding,
		...defaultMargin,
	} as TextBlockContent;
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
		const newBlock: EditorBlock = {
			id: generateId(),
			type: 'text',
			content: headingContent(level),
		};
		insertBlock(newBlock, afterBlockId);
		return newBlock;
	};

	// Whether the composite `parent` takes a child of `type` (its registry placement).
	const acceptsChild = (parent: EditorBlock, type: BlockType) =>
		editorModuleFor(parent.type)?.allowedChildTypes?.().includes(type) ?? false;

	// Insert a new Block of `type` at `slot`, a root position or one inside a
	// composite at any depth, with the defaults of that placement: column items
	// take the compact column defaults. A composite that does not accept `type`
	// passes it up: the Block goes right after the nearest ancestor whose list
	// does, and the root list takes any type. `content` adjusts the defaults.
	// Returns the Block and the composite that holds it (null for a root), or
	// null when the slot is gone.
	const handleInsertBlockAtSlot = (
		type: BlockType,
		slot: BlockSlot,
		content?: (defaults: EditorBlock['content']) => EditorBlock['content']
	): { block: EditorBlock; parentId: string | null } | null => {
		let target = slot;
		let parent: EditorBlock | null = null;
		while (target.parentId !== null) {
			const location = locateBlock(canvasBlocks.value, target.parentId, target.rootId);
			if (!location) return null;
			if (acceptsChild(location.block, type)) {
				parent = location.block;
				break;
			}
			target = {
				parentId: location.parent?.id ?? null,
				listIndex: location.listIndex,
				index: location.index + 1,
				rootId: target.rootId,
			};
		}

		const list = parent ? childBlockLists(parent)[target.listIndex] : canvasBlocks.value;
		if (!list) return null;
		const defaults =
			parent?.type === 'columns'
				? (createDefaultColumnItemContent(
						type as ColumnItem['type'],
						theme.value
					) as EditorBlock['content'])
				: createDefaultContent(type, theme.value);
		const newBlock = {
			id: generateId(),
			type,
			content: content ? content(defaults) : defaults,
		} as EditorBlock;
		list.splice(Math.min(target.index, list.length), 0, newBlock);
		if (parent) onTreeMutated?.();
		else selectedBlockId.value = newBlock.id;
		return { block: newBlock, parentId: parent?.id ?? null };
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
		handleInsertBlockAtSlot,
		handleDeleteBlock,
		handleDuplicateBlock,
		handleAddItemToColumn,
		handleColumnCountChange,
		handleDeleteNestedItem,
		handleDuplicateNestedItem,
	};
}
