import { ref, shallowRef, computed, watch, type Ref, type ShallowRef, type ComputedRef } from 'vue';
import type { EditorBlock } from '../types';
import { locateBlock, locateWithin } from '../utils/blockTree';

/**
 * A selected column item: the columns Block that holds it (a root, or nested
 * inside a container or hero) and its column.
 */
export interface ColumnContext {
	blockId: string;
	columnIndex: number;
}

/**
 * A selected container or hero item: the composite that holds it, at any
 * depth. The item may sit further down inside that composite.
 */
export interface ContainerContext {
	blockId: string;
}

export interface UseBlockStateOptions {
	canvasBlocks: Ref<EditorBlock[]>;
}

export interface UseBlockStateReturn {
	// Selection state
	selectedBlockId: Ref<string | null>;
	selectedBlock: ComputedRef<EditorBlock | null>;
	selectedColumnItemId: Ref<string | null>;
	selectedColumnContext: Ref<ColumnContext | null>;
	selectedColumnItem: ComputedRef<EditorBlock | null>;
	selectedContainerItemId: Ref<string | null>;
	selectedContainerContext: Ref<ContainerContext | null>;
	selectedContainerItem: ComputedRef<EditorBlock | null>;
	/**
	 * The root Block that owns the selection: the selected root itself, or the
	 * root a nested selection sits in. Linked-group state lives on roots.
	 */
	selectedRootId: ComputedRef<string | null>;

	// Block element refs for positioning
	blockElements: ShallowRef<Map<string, HTMLElement>>;
	selectedBlockElement: ComputedRef<HTMLElement | null>;
	clickedColumnItemElement: ShallowRef<HTMLElement | null>;
	selectedColumnItemElement: ComputedRef<HTMLElement | null>;
	clickedContainerItemElement: ShallowRef<HTMLElement | null>;
	selectedContainerItemElement: ComputedRef<HTMLElement | null>;

	// Methods
	setBlockElement: (blockId: string, el: HTMLElement | null) => void;
	handleSelectBlock: (blockId: string) => void;
	handleSelectColumnItem: (
		blockId: string,
		columnIndex: number,
		itemId: string,
		event?: MouseEvent,
		element?: HTMLElement
	) => void;
	handleSelectColumnArea: (blockId: string, event?: MouseEvent) => void;
	handleSelectContainerItem: (
		blockId: string,
		itemId: string,
		event?: MouseEvent,
		element?: HTMLElement
	) => void;
	handleSelectContainerArea: (blockId: string, event?: MouseEvent) => void;
	clearSelection: () => void;
}

/**
 * Composable for managing block selection state
 */
export function useBlockState(options: UseBlockStateOptions): UseBlockStateReturn {
	const { canvasBlocks } = options;

	// Selection state
	const selectedBlockId = ref<string | null>(null);
	const selectedColumnItemId = ref<string | null>(null);
	const selectedColumnContext = ref<ColumnContext | null>(null);
	const selectedContainerItemId = ref<string | null>(null);
	const selectedContainerContext = ref<ContainerContext | null>(null);

	// Clicked column item element for positioning
	const clickedColumnItemElement = shallowRef<HTMLElement | null>(null);

	// Clicked container item element for positioning
	const clickedContainerItemElement = shallowRef<HTMLElement | null>(null);

	// Block element refs for bubble menu positioning
	const blockElements = shallowRef<Map<string, HTMLElement>>(new Map());

	// Computed selected block
	const selectedBlock = computed(() =>
		selectedBlockId.value
			? canvasBlocks.value.find((b) => b.id === selectedBlockId.value) || null
			: null
	);

	// Computed selected block element
	const selectedBlockElement = computed(() => {
		if (!selectedBlockId.value) return null;
		return blockElements.value.get(selectedBlockId.value) || null;
	});

	// A nested item, looked up below the composite that holds it at any depth.
	const nestedItem = (scopeId: string | undefined, itemId: string | null) =>
		scopeId && itemId ? (locateWithin(canvasBlocks.value, scopeId, itemId)?.block ?? null) : null;

	const selectedColumnItem = computed(() =>
		nestedItem(selectedColumnContext.value?.blockId, selectedColumnItemId.value)
	);

	// Selected column item element
	const selectedColumnItemElement = computed(() => {
		if (!selectedColumnItemId.value) return null;
		return clickedColumnItemElement.value;
	});

	const selectedContainerItem = computed(() =>
		nestedItem(selectedContainerContext.value?.blockId, selectedContainerItemId.value)
	);

	const selectedRootId = computed(() => {
		if (selectedBlockId.value) return selectedBlockId.value;
		const scopeId = selectedColumnContext.value?.blockId ?? selectedContainerContext.value?.blockId;
		return scopeId ? (locateBlock(canvasBlocks.value, scopeId)?.root.id ?? null) : null;
	});

	// Selected container item element
	const selectedContainerItemElement = computed(() => {
		if (!selectedContainerItemId.value) return null;
		return clickedContainerItemElement.value;
	});

	// Clear element ref when selection clears
	watch(selectedColumnItemId, (newId) => {
		if (!newId) {
			clickedColumnItemElement.value = null;
		}
	});

	// Clear container item element ref when selection clears
	watch(selectedContainerItemId, (newId) => {
		if (!newId) {
			clickedContainerItemElement.value = null;
		}
	});

	// Methods
	const setBlockElement = (blockId: string, el: HTMLElement | null) => {
		if (!el) return; // Skip null from re-render ref cleanup to avoid reactive churn
		if (blockElements.value.get(blockId) === el) return; // Same DOM element — no-op
		const newMap = new Map(blockElements.value);
		newMap.set(blockId, el);
		blockElements.value = newMap;
	};

	const handleSelectBlock = (blockId: string) => {
		selectedBlockId.value = blockId;
		selectedColumnItemId.value = null;
		selectedColumnContext.value = null;
		selectedContainerItemId.value = null;
		selectedContainerContext.value = null;
	};

	const handleSelectColumnItem = (
		blockId: string,
		columnIndex: number,
		itemId: string,
		event?: MouseEvent,
		element?: HTMLElement
	) => {
		event?.stopPropagation();
		selectedBlockId.value = null;
		selectedColumnItemId.value = itemId;
		selectedColumnContext.value = { blockId, columnIndex };
		selectedContainerItemId.value = null;
		selectedContainerContext.value = null;
		const target = element || (event?.currentTarget as HTMLElement);
		if (target) {
			clickedColumnItemElement.value = target;
		}
	};

	const handleSelectColumnArea = (blockId: string, event?: MouseEvent) => {
		event?.stopPropagation();
		selectedColumnItemId.value = null;
		selectedColumnContext.value = null;
		selectedContainerItemId.value = null;
		selectedContainerContext.value = null;
		selectedBlockId.value = blockId;
	};

	const handleSelectContainerItem = (
		blockId: string,
		itemId: string,
		event?: MouseEvent,
		element?: HTMLElement
	) => {
		event?.stopPropagation();
		selectedBlockId.value = null;
		selectedColumnItemId.value = null;
		selectedColumnContext.value = null;
		selectedContainerItemId.value = itemId;
		selectedContainerContext.value = { blockId };
		const target = element || (event?.currentTarget as HTMLElement);
		if (target) {
			clickedContainerItemElement.value = target;
		}
	};

	const handleSelectContainerArea = (blockId: string, event?: MouseEvent) => {
		event?.stopPropagation();
		selectedColumnItemId.value = null;
		selectedColumnContext.value = null;
		selectedContainerItemId.value = null;
		selectedContainerContext.value = null;
		selectedBlockId.value = blockId;
	};

	const clearSelection = () => {
		selectedBlockId.value = null;
		selectedColumnItemId.value = null;
		selectedColumnContext.value = null;
		selectedContainerItemId.value = null;
		selectedContainerContext.value = null;
	};

	return {
		selectedBlockId,
		selectedBlock,
		selectedColumnItemId,
		selectedColumnContext,
		selectedColumnItem,
		selectedContainerItemId,
		selectedContainerContext,
		selectedContainerItem,
		selectedRootId,
		blockElements,
		selectedBlockElement,
		clickedColumnItemElement,
		selectedColumnItemElement,
		clickedContainerItemElement,
		selectedContainerItemElement,
		setBlockElement,
		handleSelectBlock,
		handleSelectColumnItem,
		handleSelectColumnArea,
		handleSelectContainerItem,
		handleSelectContainerArea,
		clearSelection,
	};
}
