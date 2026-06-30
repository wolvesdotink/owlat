/**
 * Cursor-based pagination parameters for list requests.
 *
 * Pagination is cursor-based: pass {@link PaginationParams.cursor} from the
 * previous response's {@link PaginationMeta.cursor} to fetch the next page.
 * There is no row ceiling — every record is reachable.
 */
export interface PaginationParams {
	/**
	 * Number of items per page (max 100). Defaults to 25.
	 */
	limit?: number;

	/**
	 * Opaque continuation cursor from a previous response's `pagination.cursor`.
	 * Omit (or pass `null`) to fetch the first page.
	 */
	cursor?: string | null;

	/**
	 * Search query to filter results. Search results are relevance-ordered.
	 */
	search?: string;
}

/**
 * Cursor-based pagination metadata returned with list responses.
 */
export interface PaginationMeta {
	/**
	 * Items per page.
	 */
	limit: number;

	/**
	 * Total number of items (across all pages).
	 */
	totalItems: number;

	/**
	 * Opaque continuation cursor for the next page, or `null` once `isDone` is
	 * true (the final page has been returned).
	 */
	cursor: string | null;

	/**
	 * True once the final page has been returned.
	 */
	isDone: boolean;
}

/**
 * Rate limit information from API response headers.
 */
export interface RateLimitInfo {
	/**
	 * Maximum requests per second.
	 */
	limit: number;

	/**
	 * Remaining requests in current window.
	 */
	remaining: number;

	/**
	 * Unix timestamp when the rate limit resets.
	 */
	reset: number;
}

/**
 * Base response wrapper for single items.
 */
export interface ApiResponse<T> {
	data: T;
}

/**
 * Response wrapper for paginated lists.
 */
export interface PaginatedResponse<T> {
	data: T[];
	pagination: PaginationMeta;
}

/**
 * Error response from the API — the HTTP serialization of an Operation error.
 * `category` is the closed classification (e.g. 'not_found', 'invalid_input',
 * 'rate_limited'); `data` carries the specifics ({ field }, { retryAfter }, …).
 */
export interface ApiErrorResponse {
	error: {
		category: string;
		message: string;
		data?: Record<string, unknown>;
	};
}
