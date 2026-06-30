import { api } from '@owlat/api';
import { truncate as truncateShared } from '@owlat/shared';
import {
	ENTRY_TYPES,
	SOURCE_CONFIG,
	TYPE_CONFIG,
	entryTypeIcon,
	entryTypeLabel,
	entryTypeVariant,
	sourceIcon,
	sourceLabel,
	type EntryType,
} from '~/utils/knowledgeEntryTypes';

export function useKnowledgeGraph() {
	const { query: searchQuery, debouncedQuery: debouncedSearch } = useDebouncedSearch(300);
	const selectedType = ref<EntryType | null>(null);

	// When searching, use the search API (skip when no search query)
	const { data: searchResults, isLoading: searchLoading } = useConvexQuery(
		api.knowledge.graph.search,
		() => {
			if (!debouncedSearch.value) return 'skip';
			return {
				searchQuery: debouncedSearch.value,
				...(selectedType.value ? { entryType: selectedType.value } : {}),
				limit: 50,
			};
		},
	);

	// When browsing a specific type (no search), use listByType (skip when
	// searching or on the "All" tab).
	const { data: typeResults, isLoading: typeLoading } = useConvexQuery(
		api.knowledge.graph.listByType,
		() => {
			if (debouncedSearch.value || selectedType.value === null) return 'skip';
			return { entryType: selectedType.value, limit: 50 };
		},
	);

	// The "All" tab (selectedType === null) lists every type, newest first.
	const { data: allResults, isLoading: allLoading } = useConvexQuery(
		api.knowledge.graph.listAll,
		() => {
			if (debouncedSearch.value || selectedType.value !== null) return 'skip';
			return { limit: 50 };
		},
	);

	const entries = computed(() => {
		if (debouncedSearch.value) return searchResults.value ?? [];
		if (selectedType.value === null) return allResults.value ?? [];
		return typeResults.value ?? [];
	});

	const isLoading = computed(() => {
		if (debouncedSearch.value) return searchLoading.value;
		if (selectedType.value === null) return allLoading.value;
		return typeLoading.value;
	});

	// Mutations
	const { run: createEntry } = useBackendOperation(
		api.knowledge.graph.createEntry,
		{ label: 'Create knowledge entry' },
	);
	const { run: updateEntry } = useBackendOperation(
		api.knowledge.graph.updateEntry,
		{ label: 'Update knowledge entry' },
	);
	const { run: deleteEntry } = useBackendOperation(
		api.knowledge.graph.deleteEntry,
		{ label: 'Delete knowledge entry' },
	);
	const { run: addRelation } = useBackendOperation(
		api.knowledge.graph.addRelation,
		{ label: 'Add knowledge relation' },
	);
	const { run: removeRelation } = useBackendOperation(
		api.knowledge.graph.removeRelation,
		{ label: 'Remove knowledge relation' },
	);

	// Helpers (re-exported from the shared presentation map)
	const typeVariant = entryTypeVariant;
	const typeIcon = entryTypeIcon;
	const typeLabel = entryTypeLabel;

	const confidenceColor = (value: number) => {
		if (value >= 0.7) return 'text-success';
		if (value >= 0.4) return 'text-warning';
		return 'text-error';
	};

	const confidenceBgColor = (value: number) => {
		if (value >= 0.7) return 'bg-success';
		if (value >= 0.4) return 'bg-warning';
		return 'bg-error';
	};

	/** UiProgressBar variant for a 0-1 confidence value (same thresholds). */
	const confidenceVariant = (value: number) => {
		if (value >= 0.7) return 'success' as const;
		if (value >= 0.4) return 'warning' as const;
		return 'error' as const;
	};

	const formatConfidence = (value: number) => `${Math.round(value * 100)}%`;

	const truncate = (text: string, max = 120) => truncateShared(text, max, '\u2026');

	return {
		// State
		searchQuery,
		debouncedSearch,
		selectedType,
		entries,
		isLoading,

		// Mutations
		createEntry,
		updateEntry,
		deleteEntry,
		addRelation,
		removeRelation,

		// Constants
		ENTRY_TYPES,
		TYPE_CONFIG,
		SOURCE_CONFIG,

		// Helpers
		typeVariant,
		typeIcon,
		typeLabel,
		sourceIcon,
		sourceLabel,
		confidenceColor,
		confidenceBgColor,
		confidenceVariant,
		formatConfidence,
		truncate,
	};
}
