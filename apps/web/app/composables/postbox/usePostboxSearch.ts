/**
 * Reactive Postbox search wrapper.
 *
 * Parses the user's free-form query into operators (`from:` / `is:` /
 * `before:` etc.) on the client, then hands the structured payload to
 * the Convex `mailMailbox.search` query. The grammar itself lives in
 * `~/utils/postboxSearchQuery` so it stays testable without a Convex mount.
 *
 * The subscription runs off a DEBOUNCED copy of the box: every keystroke used
 * to tear down and re-open a Convex subscription (typing "invoice" opened
 * seven), which is both a burst of server work and a visible flicker as each
 * partial query resolved to a different result set.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { parseSearchQuery } from '~/utils/postboxSearchQuery';
import { searchWalkStep } from '~/utils/postboxSearchWalk';

/** How long the box has to be still before the subscription re-opens. */
const SEARCH_DEBOUNCE_MS = 250;

export function usePostboxSearch(mailboxId: Ref<Id<'mailboxes'> | null>, query: Ref<string>) {
	// The box is the source of truth for what's typed; the debounced mirror is
	// the source of truth for what's SUBSCRIBED. The first value lands
	// immediately so arriving at /search?q=... doesn't idle for a beat.
	const { query: pending, debouncedQuery, setImmediate } = useDebouncedSearch(SEARCH_DEBOUNCE_MS);
	setImmediate(query.value);
	watch(query, (value) => {
		pending.value = value;
	});

	const parsed = computed(() => parseSearchQuery(debouncedQuery.value));

	// Keyset-paginated: "Load more" walks past the first page via the backend's
	// opaque cursor instead of silently stopping at the old 200-row cap. Any
	// change to the parsed query restarts from a fresh first page.
	const { rows, isLoading, isLoadingMore, error, hasMore, canLoadMore, loadMore } =
		usePostboxCursorFeed(
			api.mail.mailbox.search.search,
			() => {
				if (!mailboxId.value) return 'skip';
				const trimmed = debouncedQuery.value.trim();
				if (!trimmed) return 'skip';
				return {
					mailboxId: mailboxId.value,
					...parsed.value,
					limit: 50,
				};
			},
			computed(() => JSON.stringify(parsed.value)),
			{ keepPreviousData: true }
		);

	// While the box is ahead of the subscription the on-screen rows belong to
	// the previous query, so the page has to read as loading rather than as a
	// settled (and wrong) result set.
	const isDebouncing = computed(() => query.value !== debouncedQuery.value);

	// "Search older mail": one click keeps reading older pages until something
	// matches or the mailbox runs out (see utils/postboxSearchWalk). A new query
	// ends any walk in progress.
	const isWalking = ref(false);
	const pagesWalked = ref(0);
	function searchOlder() {
		pagesWalked.value = 0;
		isWalking.value = true;
	}
	watch(debouncedQuery, () => {
		isWalking.value = false;
	});
	watch(
		[isWalking, () => rows.value.length, hasMore, canLoadMore, isLoadingMore, error],
		() => {
			if (!isWalking.value) return;
			const step = searchWalkStep({
				resultCount: rows.value.length,
				hasMore: hasMore.value,
				canLoadMore: canLoadMore.value,
				isLoadingMore: isLoadingMore.value,
				hasError: error.value != null,
				pagesWalked: pagesWalked.value,
			});
			if (step === 'stop') isWalking.value = false;
			else if (step === 'load') {
				pagesWalked.value += 1;
				loadMore();
			}
		},
		{ flush: 'post' }
	);

	return {
		parsed,
		results: rows,
		isLoading: computed(() => isLoading.value || isDebouncing.value),
		isLoadingMore,
		hasMore,
		canLoadMore,
		loadMore,
		isWalking: readonly(isWalking),
		searchOlder,
	};
}
