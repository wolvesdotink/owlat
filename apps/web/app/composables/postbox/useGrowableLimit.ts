/**
 * Growable page limit for the "Load more" lists: starts at `page`, grows by
 * `page` up to `max`, and resets to `page` whenever `resetKey` changes (e.g. a
 * folder switch). Shared by the message list and the conversation list.
 */
export function useGrowableLimit(
	resetKey: Ref<unknown>,
	opts?: { page?: number; max?: number }
) {
	const page = opts?.page ?? 50;
	const max = opts?.max ?? 500;
	const limit = ref(page);

	watch(resetKey, () => {
		limit.value = page;
	});

	function loadMore() {
		limit.value = Math.min(limit.value + page, max);
	}

	const atMax = computed(() => limit.value >= max);

	return { limit, loadMore, atMax };
}
