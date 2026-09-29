import { watch, type Ref } from 'vue';

/** The slice of a `usePaginatedQuery` handle the drain loop drives. */
interface PaginatedPages {
	status: Readonly<Ref<string>>;
	loadMore: (numItems: number) => unknown;
}

/**
 * Pull every page of a paginated query, `pageSize` rows at a time.
 *
 * For lists that sort and filter client-side with no pager of their own (the
 * segment and topic lists, every topic picker): if only the first page is
 * loaded, a client sort reorders a partial set and anything past the first page
 * is unreachable. Each time the subscription settles on `CanLoadMore` the next
 * page is requested, until it reports `Exhausted`.
 */
export function useLoadAllPages<T extends PaginatedPages>(paginated: T, pageSize: number): T {
	watch(
		paginated.status,
		(status) => {
			if (status === 'CanLoadMore') paginated.loadMore(pageSize);
		},
		{ immediate: true }
	);
	return paginated;
}
