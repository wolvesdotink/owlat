/**
 * Debounced search composable
 * Provides a search query with debounced value for API calls
 */

export function useDebouncedSearch(delay = 300) {
	const query = ref('');
	const debouncedQuery = ref('');
	let timeoutId: ReturnType<typeof setTimeout> | null = null;

	watch(query, (value) => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		timeoutId = setTimeout(() => {
			debouncedQuery.value = value;
		}, delay);
	});

	const clear = () => {
		query.value = '';
		debouncedQuery.value = '';
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	};

	const setImmediate = (value: string) => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		query.value = value;
		debouncedQuery.value = value;
	};

	if (getCurrentInstance()) {
		onUnmounted(() => {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		});
	}

	return {
		query,
		debouncedQuery: readonly(debouncedQuery),
		// Aliases for backward compatibility
		searchQuery: query,
		debouncedSearch: readonly(debouncedQuery),
		clear,
		setImmediate,
	};
}
