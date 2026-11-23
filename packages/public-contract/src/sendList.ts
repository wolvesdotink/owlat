/**
 * The list of `GET /api/v1/transactional`: its page envelope and its bounds.
 * Plain TypeScript with no imports, re-exported by `types.ts`; see there for
 * why.
 */

/**
 * The longest time window one send list covers, in days. The window is when
 * the sends were queued; a request without `since` covers this many days
 * before `until`.
 */
export const SEND_LIST_MAX_WINDOW_DAYS = 30;

/**
 * Pagination of a list that has no total: counting every match would read
 * every match, so the page says only whether more follow.
 */
export interface CursorPaginationMeta {
	/** Items per page. */
	limit: number;
	/**
	 * Opaque continuation cursor for the next page, or `null` once `isDone` is
	 * true. It belongs to the filters of the request that returned it.
	 */
	cursor: string | null;
	/** True once the final page has been returned. */
	isDone: boolean;
}

/** One page of a list that has no total. */
export interface CursorPaginatedResponse<T> {
	data: T[];
	pagination: CursorPaginationMeta;
}
