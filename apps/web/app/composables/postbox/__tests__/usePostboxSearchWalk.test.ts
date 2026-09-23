/**
 * "Search older mail" (#777): one click keeps asking for older pages until a
 * match turns up or the mailbox runs out, and a new query ends the walk.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';

vi.mock('@owlat/api', () => ({ api: { mail: { mailbox: { search: { search: 'search' } } } } }));

const rows = ref<Array<{ _id: string }>>([]);
const pagesLeft = ref(3);
const isLoadingMore = ref(false);
const error = ref<Error | null>(null);
/** What the next page brings when it lands. */
let nextPageRows: Array<{ _id: string }> = [];
// Like the real feed: the page is pending for a tick, then lands.
const loadMore = vi.fn(() => {
	isLoadingMore.value = true;
	setTimeout(() => {
		pagesLeft.value -= 1;
		rows.value = [...rows.value, ...nextPageRows];
		isLoadingMore.value = false;
	}, 0);
});

beforeAll(() => {
	Object.assign(globalThis, {
		useDebouncedSearch,
		usePostboxCursorFeed: () => ({
			rows,
			isLoading: ref(false),
			isLoadingMore,
			error,
			hasMore: computed(() => pagesLeft.value > 0),
			canLoadMore: computed(() => pagesLeft.value > 0),
			loadMore,
		}),
	});
});

const { usePostboxSearch } = await import('../usePostboxSearch');

async function settle() {
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();
	}
}

beforeEach(() => {
	rows.value = [];
	pagesLeft.value = 3;
	isLoadingMore.value = false;
	error.value = null;
	nextPageRows = [];
	loadMore.mockClear();
});

describe('usePostboxSearch — search older mail', () => {
	it('walks page after page until the mailbox runs out', async () => {
		const search = usePostboxSearch(ref('mb' as never), ref('invoice'));
		search.searchOlder();
		await settle();
		expect(loadMore).toHaveBeenCalledTimes(3);
		expect(search.isWalking.value).toBe(false);
	});

	it('stops at the first page with a match', async () => {
		nextPageRows = [{ _id: 'hit' }];
		const search = usePostboxSearch(ref('mb' as never), ref('invoice'));
		search.searchOlder();
		await settle();
		expect(loadMore).toHaveBeenCalledTimes(1);
		expect(search.isWalking.value).toBe(false);
	});

	it('stops when a page fails', async () => {
		const search = usePostboxSearch(ref('mb' as never), ref('invoice'));
		error.value = new Error('offline');
		search.searchOlder();
		await settle();
		expect(loadMore).not.toHaveBeenCalled();
		expect(search.isWalking.value).toBe(false);
	});

	it('does not walk until asked', async () => {
		usePostboxSearch(ref('mb' as never), ref('invoice'));
		await settle();
		expect(loadMore).not.toHaveBeenCalled();
	});
});
