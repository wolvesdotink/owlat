/**
 * Accumulate-and-dedup helper for cursor-paginated Convex queries that are
 * driven manually (a `cursor` ref fed into `useOrganizationQuery`, with the
 * server returning `{ nextCursor, hasMore }`) rather than via Convex's native
 * `paginationOpts` pagination (for which see `usePaginatedQuery`).
 *
 * The audit-log page owned this logic inline. The rule it encodes:
 *   - the FIRST page (cursor null/undefined) REPLACES the accumulated list,
 *   - every subsequent page APPENDS, deduped by `_id`,
 *   - changing a filter resets the cursor and clears the list synchronously, so
 *     the cursor — a position in the underlying stream — is never reused across
 *     filter changes (which would skip matching rows).
 *
 * @param page    reactive page payload, expected to expose `{ items, nextCursor, hasMore }`
 * @param cursor  the cursor ref the caller passes into the query args
 * @param resetSources reactive sources whose change resets to a fresh first page
 */
import type { Ref, WatchSource } from 'vue';

interface CursorPage<Item> {
	items: Item[];
	nextCursor?: string | null;
	hasMore?: boolean;
}

export function useAccumulatedCursorList<Item extends { _id: string }>(
	page: Ref<CursorPage<Item> | null | undefined>,
	cursor: Ref<string | null>,
	resetSources: WatchSource[] = [],
) {
	const accumulated = ref<Item[]>([]) as Ref<Item[]>;

	watch(
		page,
		(data) => {
			if (!data?.items) return;
			const next = [...data.items];
			if (!cursor.value) {
				accumulated.value = next;
			} else {
				const seen = new Set(accumulated.value.map((i) => i._id));
				accumulated.value = [...accumulated.value, ...next.filter((i) => !seen.has(i._id))];
			}
		},
		{ immediate: true },
	);

	// Reset to a fresh first page when any filter changes. `flush: 'sync'` so the
	// cursor is cleared before the query re-subscribes with new args.
	if (resetSources.length > 0) {
		watch(
			resetSources,
			() => {
				cursor.value = null;
				accumulated.value = [];
			},
			{ flush: 'sync' },
		);
	}

	/** Advance to the next page if the server reported one. */
	const loadMore = () => {
		if (page.value?.nextCursor) {
			cursor.value = page.value.nextCursor;
		}
	};

	/** Clear all accumulated rows and reset the cursor to the first page. */
	const reset = () => {
		cursor.value = null;
		accumulated.value = [];
	};

	const hasMore = computed(() => page.value?.hasMore === true);

	return { accumulated, loadMore, reset, hasMore };
}
