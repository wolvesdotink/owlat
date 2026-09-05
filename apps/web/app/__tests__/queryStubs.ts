import { vi } from 'vitest';
import { ref } from 'vue';

/** A ref-shaped query result: what every Convex-backed composable hands a template. */
export function queryResult<T>(data: T) {
	return {
		data: ref(data),
		isLoading: ref(false),
		isRefetching: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	};
}

/** A `usePaginatedQuery` result with a single, already-exhausted page. */
export function paginatedResult<T>(results: T[]) {
	return {
		results: ref(results),
		status: ref('Exhausted'),
		isLoading: ref(false),
		error: ref(null),
		loadMore: vi.fn(),
		reset: vi.fn(),
	};
}
