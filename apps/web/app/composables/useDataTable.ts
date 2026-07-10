/**
 * Composable for data table controls (search, sort, pagination)
 * Standardizes the common patterns used across list pages
 */

export interface DataTableOptions<TSortField extends string = string> {
	/** Default field to sort by */
	defaultSort: TSortField;
	/** Default sort order (defaults to 'desc') */
	defaultOrder?: 'asc' | 'desc';
	/** Number of items per page (defaults to 25) */
	pageSize?: number;
	/** Debounce delay for search in ms (defaults to 300) */
	searchDebounceDelay?: number;
	/**
	 * The columns that actually offer a sort affordance. Declaring them here is
	 * the single source of truth the list pages share: a header is rendered
	 * sortable if and only if `isSortable(field)` is true, so "sortable columns
	 * declared" can never drift from "sortable columns rendered". When omitted,
	 * every field is treated as sortable (back-compat).
	 */
	sortableFields?: readonly TSortField[];
}

export function useDataTable<TSortField extends string = string>(
	options: DataTableOptions<TSortField>
) {
	const { defaultSort, defaultOrder = 'desc', pageSize = 25, searchDebounceDelay = 300 } = options;

	// Sortable-column contract (see DataTableOptions.sortableFields).
	const declaredSortable = options.sortableFields ?? [];
	const sortableSet = new Set<TSortField>(declaredSortable);
	const isSortable = (field: TSortField): boolean =>
		declaredSortable.length === 0 || sortableSet.has(field);

	// Integrate useDebouncedSearch
	const {
		searchQuery,
		debouncedSearch,
		clear: clearSearch,
		setImmediate: setSearchImmediate,
	} = useDebouncedSearch(searchDebounceDelay);

	// Sort state
	const sortBy = ref<TSortField>(defaultSort) as Ref<TSortField>;
	const sortOrder = ref<'asc' | 'desc'>(defaultOrder);

	// Pagination state
	const currentPage = ref(1);

	// Reset to page 1 when search changes
	watch(debouncedSearch, () => {
		currentPage.value = 1;
	});

	/**
	 * Toggle sort direction for a field, or change to a new field
	 * When changing to a new field, defaults to 'asc' for most fields,
	 * but 'desc' for date/timestamp fields (when field name includes 'date', 'At', or 'time')
	 */
	const toggleSort = (field: TSortField) => {
		// Undeclared columns can never sort — keeps "declared sortable" load-bearing.
		if (!isSortable(field)) return;
		if (sortBy.value === field) {
			sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
		} else {
			sortBy.value = field;
			// Default to desc for date-like fields, asc for others
			const isDateField = /date|At$|time/i.test(field);
			sortOrder.value = isDateField ? 'desc' : 'asc';
		}
	};

	/**
	 * The chevron for a column header: null unless the field is the active sort,
	 * then up/down for asc/desc. Shared so every list renders the same affordance.
	 */
	const getSortIcon = (field: TSortField): string | null => {
		if (sortBy.value !== field) return null;
		return sortOrder.value === 'asc' ? 'lucide:chevron-up' : 'lucide:chevron-down';
	};

	/**
	 * Get page numbers array with ellipsis support
	 * Returns an array of page numbers and '...' for ellipsis
	 */
	const getPageNumbers = (totalPages: number): (number | '...')[] => {
		const pages: (number | '...')[] = [];
		const current = currentPage.value;

		if (totalPages <= 7) {
			// Show all pages if 7 or fewer
			for (let i = 1; i <= totalPages; i++) {
				pages.push(i);
			}
		} else if (current <= 3) {
			// Near the start: show 1, 2, 3, 4, ..., last
			pages.push(1, 2, 3, 4, '...', totalPages);
		} else if (current >= totalPages - 2) {
			// Near the end: show 1, ..., last-3, last-2, last-1, last
			pages.push(1, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
		} else {
			// In the middle: show 1, ..., current-1, current, current+1, ..., last
			pages.push(1, '...', current - 1, current, current + 1, '...', totalPages);
		}

		return pages;
	};

	/**
	 * Navigate to a specific page
	 */
	const goToPage = (page: number, totalPages: number) => {
		if (page >= 1 && page <= totalPages) {
			currentPage.value = page;
		}
	};

	/**
	 * Reset all state to defaults
	 */
	const reset = () => {
		clearSearch();
		sortBy.value = defaultSort;
		sortOrder.value = defaultOrder;
		currentPage.value = 1;
	};

	return {
		// Search
		searchQuery,
		debouncedSearch,
		clearSearch,
		setSearchImmediate,

		// Sort
		sortBy: readonly(sortBy) as Readonly<Ref<TSortField>>,
		sortOrder: readonly(sortOrder),
		toggleSort,
		getSortIcon,
		isSortable,

		// Pagination
		currentPage,
		pageSize,
		getPageNumbers,
		goToPage,

		// Utilities
		reset,
	};
}
