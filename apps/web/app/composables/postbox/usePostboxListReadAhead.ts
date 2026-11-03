/**
 * Read-ahead for a message list: when the j/k focus or the open message
 * changes, hold the next and previous rows' thread and inline-body queries (the
 * ones the reader opens with; debounced, LRU-capped and fail-soft) so Enter and
 * auto-advance open from cache.
 *
 * `prefetchRow` is the mouse half: hovering (or tabbing to) a row warms the
 * thread and body the click is about to need. The prefetcher's 150ms debounce
 * means a pointer sweeping down the list warms only where it comes to rest, and
 * its LRU cap bounds what a long sweep can accumulate, so this needs no
 * throttle of its own.
 */

import { watch, type Ref } from 'vue';

export function usePostboxListReadAhead(args: {
	focusedIndex: Ref<number>;
	visibleIds: Ref<readonly string[]>;
	activeMessageId: () => string | null | undefined;
}) {
	const { prefetch } = usePostboxPrefetch();

	watch([args.focusedIndex, args.activeMessageId], () => {
		const ids = args.visibleIds.value;
		const open = args.activeMessageId();
		let anchor = args.focusedIndex.value;
		if (anchor < 0 && open) anchor = ids.findIndex((id) => id === open);
		if (anchor < 0) return;
		prefetch([ids[anchor + 1], ids[anchor - 1]]);
	});

	return { prefetchRow: (id: string) => prefetch([id]) };
}
