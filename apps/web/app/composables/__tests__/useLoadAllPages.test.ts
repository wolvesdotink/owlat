/**
 * `useLoadAllPages` drains a paginated query for the lists that sort and filter
 * client-side. `useTopicsList` used to stop at the first 100 topics, so a topic
 * the list page showed could be missing from every topic picker.
 */
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useLoadAllPages } from '../useLoadAllPages';

function pages(initial: string) {
	const status = ref(initial);
	const loadMore = vi.fn();
	return { status, loadMore, results: ref<string[]>([]) };
}

describe('useLoadAllPages', () => {
	it('asks for the next page as soon as one is available', () => {
		const paginated = pages('CanLoadMore');
		useLoadAllPages(paginated, 100);
		expect(paginated.loadMore).toHaveBeenCalledWith(100);
	});

	it('keeps asking each time the subscription settles on CanLoadMore', async () => {
		const paginated = pages('LoadingFirstPage');
		useLoadAllPages(paginated, 50);
		expect(paginated.loadMore).not.toHaveBeenCalled();

		for (const status of ['CanLoadMore', 'LoadingMore', 'CanLoadMore', 'LoadingMore']) {
			paginated.status.value = status;
			await nextTick();
		}
		expect(paginated.loadMore).toHaveBeenCalledTimes(2);
		expect(paginated.loadMore).toHaveBeenLastCalledWith(50);
	});

	it('stops once the query is exhausted', async () => {
		const paginated = pages('LoadingMore');
		useLoadAllPages(paginated, 50);
		paginated.status.value = 'Exhausted';
		await nextTick();
		expect(paginated.loadMore).not.toHaveBeenCalled();
	});

	it('hands the paginated handle back, so a caller can destructure it', () => {
		const paginated = pages('Exhausted');
		expect(useLoadAllPages(paginated, 10)).toBe(paginated);
	});
});
