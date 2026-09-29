import { computed, watch, type Ref } from 'vue';
import { useDataTable } from './useDataTable';

/** The contact fields a member row carries, whatever list it comes from. */
export interface MemberRow {
	_id: string;
	email?: string | null;
	firstName?: string | null;
	lastName?: string | null;
}

type MemberSortField<TDate extends string> = 'email' | 'firstName' | 'lastName' | TDate;

/** The part of a `usePaginatedQuery` handle the member table reads and drives. */
interface MemberPages<TRow> {
	results: Ref<TRow[]>;
	status: Readonly<Ref<string>>;
	loadMore: (numItems: number) => unknown;
}

interface UseMemberTableOptions<TDate extends string, TRow> {
	paginated: MemberPages<TRow>;
	/** The timestamp the date column shows and sorts by (`createdAt`, `addedAt`). */
	dateField: TDate;
	/** How many rows each `loadMore` asks the server for. */
	loadMoreSize: number;
	/** The column a fresh visit sorts by; `email` when omitted. */
	defaultSort?: MemberSortField<TDate>;
	/** Rows per table page. */
	pageSize?: number;
}

/**
 * The contact table on a segment's and a topic's detail page: client-side
 * search over email and name, column sort, paging and the loading of further
 * server pages.
 *
 * The server query is cursor-paginated but the table pages client-side over the
 * rows loaded so far. More pages are pulled when the user nears the end of the
 * loaded window, and eagerly while a search is active, because a client-side
 * search has to see every member to find a match.
 *
 * Sort, paging and the ellipsis rule come from `useDataTable`, so a date column
 * opens newest first and a new search or sort goes back to page 1, as on every
 * other list.
 */
export function useMemberTable<
	TDate extends string,
	TRow extends MemberRow & Partial<Record<TDate, number | null>>,
>(options: UseMemberTableOptions<TDate, TRow>) {
	const { paginated, dateField, loadMoreSize } = options;
	type SortField = MemberSortField<TDate>;

	const defaultSort: SortField = options.defaultSort ?? 'email';
	const table = useDataTable<SortField>({
		defaultSort,
		// The same rule `toggleSort` applies to a column opened later.
		defaultOrder: defaultSort === dateField ? 'desc' : 'asc',
		pageSize: options.pageSize ?? 25,
		sortableFields: ['email', 'firstName', 'lastName', dateField],
	});
	const { debouncedSearch, sortBy, sortOrder, currentPage, pageSize } = table;

	const text = (value: string | null | undefined) => value ?? '';
	const timestamp = (row: TRow) => (row[dateField] as number | null | undefined) ?? 0;

	const filteredRows = computed<TRow[]>(() => {
		const query = debouncedSearch.value.toLowerCase();
		const rows = query
			? paginated.results.value.filter((row) =>
					[row.email, row.firstName, row.lastName].some((value) =>
						text(value).toLowerCase().includes(query)
					)
				)
			: [...paginated.results.value];

		const field = sortBy.value;
		const direction = sortOrder.value === 'asc' ? 1 : -1;
		return rows.sort((a, b) => {
			const comparison =
				field === dateField
					? timestamp(a) - timestamp(b)
					: text(a[field as keyof MemberRow]).localeCompare(text(b[field as keyof MemberRow]));
			return comparison * direction;
		});
	});

	const totalCount = computed(() => filteredRows.value.length);
	const totalPages = computed(() => Math.max(1, Math.ceil(totalCount.value / pageSize)));

	const pageRows = computed(() => {
		const start = (currentPage.value - 1) * pageSize;
		return filteredRows.value.slice(start, start + pageSize);
	});

	// The header hands back a column name as a plain string; `useDataTable`
	// ignores any that is not one of the four declared above.
	const isSortable = (field: string) => table.isSortable(field as SortField);
	const toggleSort = (field: string) => table.toggleSort(field as SortField);
	const getSortIcon = (field: string) => table.getSortIcon(field as SortField);

	const pageNumbers = computed(() => table.getPageNumbers(totalPages.value));
	const goToPage = (page: number) => table.goToPage(page, totalPages.value);

	/** 1-based bounds of the rows on screen, or null when nothing matches. */
	const showingRange = computed(() => {
		if (totalCount.value === 0) return null;
		return {
			start: (currentPage.value - 1) * pageSize + 1,
			end: Math.min(currentPage.value * pageSize, totalCount.value),
			total: totalCount.value,
		};
	});

	watch(
		[currentPage, debouncedSearch, paginated.status],
		() => {
			if (paginated.status.value !== 'CanLoadMore') return;
			const loaded = paginated.results.value.length;
			const needed = (currentPage.value + 1) * pageSize;
			if (debouncedSearch.value || loaded < needed) paginated.loadMore(loadMoreSize);
		},
		{ immediate: true }
	);

	return {
		searchQuery: table.searchQuery,
		debouncedSearch,
		clearSearch: table.clearSearch,
		sortBy,
		sortOrder,
		toggleSort,
		getSortIcon,
		isSortable,
		currentPage,
		totalPages,
		totalCount,
		pageNumbers,
		goToPage,
		filteredRows,
		pageRows,
		showingRange,
	};
}
