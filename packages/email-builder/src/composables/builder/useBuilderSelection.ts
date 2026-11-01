import { computed, provide, type Ref } from 'vue';
import type { EditorBlock, RemoteBlockMark } from '../../types';
import type { ParentContext } from '../../components/canvas/types';
import { locateBlock, locateWithin } from '../../utils/blockTree';
// Loading the module registers every block schema as a side effect.
import { getSchema } from '../../schema';
import { useBlockState } from '../useBlockState';
import type { UseLinkedBlocksReturn } from '../useLinkedBlocks';

interface UseBuilderSelectionOptions {
	canvasBlocks: Ref<EditorBlock[]>;
	linkedBlocks: Pick<UseLinkedBlocksReturn, 'isLinkedBlock' | 'getLinkedGroupByBlockId'>;
	/** Other people on root blocks, keyed by root block id (co-editing). */
	remoteMarks: () => Record<string, RemoteBlockMark> | undefined;
}

/**
 * The builder's block selection: which Block is active (a root or a nested
 * item at any depth), whether it may be edited, and selecting a Block while
 * respecting linked groups and other people's locks.
 */
export function useBuilderSelection({
	canvasBlocks,
	linkedBlocks,
	remoteMarks,
}: UseBuilderSelectionOptions) {
	const { isLinkedBlock, getLinkedGroupByBlockId } = linkedBlocks;

	// Block selection
	const blockState = useBlockState({ canvasBlocks });
	const {
		selectedBlock,
		selectedColumnItemId,
		selectedColumnItem,
		selectedContainerItemId,
		selectedContainerItem,
		blockElements,
		handleSelectBlock,
		handleSelectColumnItem,
		handleSelectContainerItem,
	} = blockState;

	// Provide setBlockElement for CanvasBlock element registration
	provide('setBlockElement', blockState.setBlockElement);

	// Active block: nested item takes priority over root selection
	const activeBlock = computed<EditorBlock | null>(() => {
		return selectedColumnItem.value ?? selectedContainerItem.value ?? selectedBlock.value;
	});

	// The nested item ID for passing down to CanvasArea/CanvasBlock
	const selectedNestedItemId = computed(() => {
		return selectedColumnItemId.value ?? selectedContainerItemId.value ?? null;
	});

	// Active block element for toolbar positioning
	const activeBlockElement = computed<HTMLElement | null>(() => {
		if (!activeBlock.value) return null;
		return blockElements.value.get(activeBlock.value.id) || null;
	});

	// Active block schema
	const activeBlockSchema = computed(() => {
		if (!activeBlock.value) return undefined;
		return getSchema(activeBlock.value.type);
	});

	// Linked block state for the active selection. Linked-group state lives on
	// the root Block, however deep the selection is.
	const selectedRootId = blockState.selectedRootId;
	const isActiveBlockLinked = computed(() =>
		selectedRootId.value ? isLinkedBlock(selectedRootId.value) : false
	);

	const activeLinkedBlockName = computed<string | null>(() => {
		if (!isActiveBlockLinked.value || !selectedRootId.value) return null;
		const group = getLinkedGroupByBlockId(selectedRootId.value);
		return group?.blockName ?? null;
	});

	/**
	 * Whether the content of the Block `blockId` (a root or a nested item) may be
	 * edited. A linked Block mirrors the saved-block library, so nothing inside
	 * it is edited in place until it is detached.
	 */
	function isEditable(blockId: string): boolean {
		const location = locateBlock(canvasBlocks.value, blockId, selectedRootId.value);
		return !!location && !isLinkedBlock(location.root.id) && !isLockedRoot(location.root.id);
	}

	/** Someone else holds this root block (co-editing): hands off here. */
	function isLockedRoot(rootId: string): boolean {
		return remoteMarks()?.[rootId]?.isLocked === true;
	}

	/** Select a root block, unless someone else holds it. */
	function selectRoot(blockId: string) {
		if (isLockedRoot(blockId)) return;
		handleSelectBlock(blockId);
	}

	/**
	 * Select the nested item `itemId`, found anywhere below the composite
	 * `scopeId`. Inside a linked Block the root is selected instead: the group is
	 * edited as a whole.
	 */
	function selectNestedItem(scopeId: string, itemId: string, element?: HTMLElement) {
		const location = locateWithin(canvasBlocks.value, scopeId, itemId);
		if (!location?.parent || isLockedRoot(location.root.id)) return;
		if (isLinkedBlock(location.root.id)) {
			handleSelectBlock(location.root.id);
			return;
		}
		if (location.parent.type === 'columns') {
			handleSelectColumnItem(location.parent.id, location.listIndex, itemId, undefined, element);
		} else {
			handleSelectContainerItem(location.parent.id, itemId, undefined, element);
		}
	}

	// Handle nested selection from the canvas, at any depth
	function handleSelectNested(payload: {
		itemId: string;
		context: ParentContext;
		element: HTMLElement;
	}) {
		selectNestedItem(payload.context.parentId, payload.itemId, payload.element);
	}

	return {
		blockState,
		activeBlock,
		selectedNestedItemId,
		activeBlockElement,
		activeBlockSchema,
		selectedRootId,
		isActiveBlockLinked,
		activeLinkedBlockName,
		isEditable,
		isLockedRoot,
		selectRoot,
		selectNestedItem,
		handleSelectNested,
	};
}
