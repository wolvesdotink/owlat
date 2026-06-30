/**
 * Composable for managing bulk selection of items
 * Provides functionality for selecting, deselecting, and performing bulk operations
 */
export function useBulkSelection<TId extends string>(options?: {
	onSelectionChange?: (ids: Set<TId>) => void;
}) {
	const selectedIds = ref<Set<TId>>(new Set()) as Ref<Set<TId>>;
	const isSelectAllMatching = ref(false);
	const allMatchingIds = ref<TId[]>([]) as Ref<TId[]>;
	const isLoadingAllMatching = ref(false);

	// Check if all items on current page are selected
	const isAllPageSelected = (currentPageIds: TId[]) => {
		if (currentPageIds.length === 0) return false;
		return currentPageIds.every((id) => selectedIds.value.has(id));
	};

	// Check if some items are selected
	const hasSelected = computed(() => selectedIds.value.size > 0);

	// Get selected count display text
	const selectedCountText = computed(() => {
		if (isSelectAllMatching.value) {
			return `${allMatchingIds.value.length} selected (all matching)`;
		}
		return `${selectedIds.value.size} selected`;
	});

	// Toggle select all on current page
	const toggleSelectAll = (currentPageIds: TId[]) => {
		if (isAllPageSelected(currentPageIds)) {
			// Deselect all on current page
			currentPageIds.forEach((id) => selectedIds.value.delete(id));
			isSelectAllMatching.value = false;
		} else {
			// Select all on current page
			currentPageIds.forEach((id) => selectedIds.value.add(id));
		}
		// Trigger reactivity
		selectedIds.value = new Set(selectedIds.value);
		options?.onSelectionChange?.(selectedIds.value);
	};

	// Toggle single item selection
	const toggleSelection = (id: TId) => {
		if (selectedIds.value.has(id)) {
			selectedIds.value.delete(id);
			isSelectAllMatching.value = false;
		} else {
			selectedIds.value.add(id);
			// Adding an item diverges from the "all matching" set, so the
			// count text must stop claiming "(all matching)".
			isSelectAllMatching.value = false;
		}
		// Trigger reactivity
		selectedIds.value = new Set(selectedIds.value);
		options?.onSelectionChange?.(selectedIds.value);
	};

	// Select item
	const select = (id: TId) => {
		selectedIds.value.add(id);
		isSelectAllMatching.value = false;
		selectedIds.value = new Set(selectedIds.value);
		options?.onSelectionChange?.(selectedIds.value);
	};

	// Deselect item
	const deselect = (id: TId) => {
		selectedIds.value.delete(id);
		isSelectAllMatching.value = false;
		selectedIds.value = new Set(selectedIds.value);
		options?.onSelectionChange?.(selectedIds.value);
	};

	// Clear all selections
	const clearSelection = () => {
		selectedIds.value = new Set();
		isSelectAllMatching.value = false;
		allMatchingIds.value = [];
		options?.onSelectionChange?.(selectedIds.value);
	};

	// Set all matching items
	const setAllMatching = (ids: TId[]) => {
		allMatchingIds.value = ids;
		selectedIds.value = new Set(ids);
		isSelectAllMatching.value = true;
		options?.onSelectionChange?.(selectedIds.value);
	};

	// Get selected IDs as array
	const getSelectedArray = () => Array.from(selectedIds.value);

	return {
		selectedIds: readonly(selectedIds),
		isSelectAllMatching: readonly(isSelectAllMatching),
		allMatchingIds: readonly(allMatchingIds),
		isLoadingAllMatching,
		hasSelected,
		selectedCountText,
		isAllPageSelected,
		toggleSelectAll,
		toggleSelection,
		select,
		deselect,
		clearSelection,
		setAllMatching,
		getSelectedArray,
	};
}
