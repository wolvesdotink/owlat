/**
 * Convert an optional cursor string to the cursor type expected by Convex .paginate().
 * Bridges `string | undefined` (from args) to `string | null` (paginate expects).
 */
export function toPaginationCursor(cursor: string | undefined): string | null {
	return cursor ?? null;
}
