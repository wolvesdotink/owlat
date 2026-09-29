import { ref, type Ref } from 'vue';
import type { EditorBlock, SavedBlock } from '../types';
import { generateId, parseStoredBlocks, regenerateNestedBlockIds } from '../utils';
import { useEmailBuilderHandlers } from './useEmailBuilderHandlers';

export interface SavedBlockPickerState {
	isOpen: boolean;
	position: { top: number; left: number };
	selectedIndex: number;
	blocks: SavedBlock[];
	isLoading: boolean;
}

export interface UseSavedBlockPickerOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	selectedBlockId: Ref<string | null>;
}

export interface UseSavedBlockPickerReturn {
	savedBlockPickerState: Ref<SavedBlockPickerState>;

	openSavedBlockPicker: (position: { top: number; left: number }) => Promise<void>;
	closeSavedBlockPicker: () => void;
	handleSavedBlockSelect: (block: SavedBlock) => void;
}

/**
 * Composable for managing the saved block picker state
 */
export function useSavedBlockPicker(
	options: UseSavedBlockPickerOptions
): UseSavedBlockPickerReturn {
	const { canvasBlocks, selectedBlockId } = options;
	const handlers = useEmailBuilderHandlers();

	const savedBlockPickerState = ref<SavedBlockPickerState>({
		isOpen: false,
		position: { top: 0, left: 0 },
		selectedIndex: 0,
		blocks: [],
		isLoading: false,
	});

	const openSavedBlockPicker = async (position: { top: number; left: number }) => {
		if (!handlers.savedBlocks) return;

		savedBlockPickerState.value = {
			isOpen: true,
			position,
			selectedIndex: 0,
			blocks: [],
			isLoading: true,
		};

		try {
			savedBlockPickerState.value.blocks = await handlers.savedBlocks.fetch();
		} catch {
			// Fetch failed silently
		} finally {
			savedBlockPickerState.value.isLoading = false;
		}
	};

	const closeSavedBlockPicker = () => {
		savedBlockPickerState.value.isOpen = false;
	};

	const handleSavedBlockSelect = (block: SavedBlock) => {
		try {
			const groupId = generateId(); // Shared groupId for all blocks from this insertion

			const savedBlockRef = {
				blockId: block._id,
				groupId,
				blockName: block.name,
			};

			// Deep-clone a stored block, assign a fresh id + savedBlockRef, and
			// regenerate any nested container/column IDs.
			const rehydrateSavedBlock = (b: EditorBlock): EditorBlock => {
				const newBlock: EditorBlock = {
					id: generateId(),
					type: b.type,
					content: JSON.parse(JSON.stringify(b.content)),
					savedBlockRef,
				};
				// Regenerate nested IDs for containers and columns
				regenerateNestedBlockIds(newBlock);
				return newBlock;
			};

			// One reader for every stored shape: the { blocks } envelope, a bare
			// array and the legacy single block.
			const blocksToInsert = parseStoredBlocks(block.content).map(rehydrateSavedBlock);

			if (blocksToInsert.length > 0) {
				// Find the insertion point - after currently selected block or at the end
				const insertIndex = selectedBlockId.value
					? canvasBlocks.value.findIndex((b) => b.id === selectedBlockId.value) + 1
					: canvasBlocks.value.length;

				// Insert all blocks
				canvasBlocks.value.splice(insertIndex, 0, ...blocksToInsert);

				// Select the first inserted block
				const firstBlock = blocksToInsert[0];
				if (firstBlock) {
					selectedBlockId.value = firstBlock.id;
				}
			}
		} catch {
			// A block whose content cannot be cloned is skipped silently
		}

		closeSavedBlockPicker();
	};

	return {
		savedBlockPickerState,
		openSavedBlockPicker,
		closeSavedBlockPicker,
		handleSavedBlockSelect,
	};
}
