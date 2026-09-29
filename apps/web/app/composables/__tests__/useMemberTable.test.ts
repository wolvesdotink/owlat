/**
 * `useMemberTable` is the state behind the contact table on a segment's and a
 * topic's detail page. Both pages used to carry their own copy of the filter,
 * the sort, the paging and the progressive `loadMore` watcher, and the copies
 * had drifted: segments opened every column ascending, topics opened its date
 * column descending. The table now takes sort and paging from `useDataTable`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useDebouncedSearch } from '../useDebouncedSearch';
import { useMemberTable } from '../useMemberTable';

beforeAll(() => {
	vi.stubGlobal('useDebouncedSearch', useDebouncedSearch);
});

afterEach(() => {
	vi.useRealTimers();
});

interface Member {
	_id: string;
	email?: string;
	firstName?: string;
	lastName?: string;
	addedAt: number;
}

const member = (n: number, extra: Partial<Member> = {}): Member => ({
	_id: `c_${n}`,
	email: `user${String(n).padStart(3, '0')}@example.com`,
	addedAt: n,
	...extra,
});

function setup(rows: Member[], status = 'Exhausted', extra: { defaultSort?: 'addedAt' } = {}) {
	const paginated = {
		results: ref(rows),
		status: ref(status),
		loadMore: vi.fn(),
	};
	const table = useMemberTable({
		paginated,
		dateField: 'addedAt',
		loadMoreSize: 50,
		...extra,
	});
	return { paginated, table };
}

async function search(table: ReturnType<typeof setup>['table'], query: string) {
	table.searchQuery.value = query;
	await nextTick();
	vi.advanceTimersByTime(300);
	await nextTick();
}

describe('filter', () => {
	it('matches the search against email, first name and last name, case-insensitively', async () => {
		vi.useFakeTimers();
		const { table } = setup([
			member(1, { email: 'ada@example.com' }),
			member(2, { firstName: 'Grace' }),
			member(3, { lastName: 'Adams' }),
			member(4, { email: undefined, firstName: 'Linus' }),
		]);

		await search(table, 'ADA');
		expect(table.filteredRows.value.map((row) => row._id).sort()).toEqual(['c_1', 'c_3']);

		await search(table, 'grace');
		expect(table.filteredRows.value.map((row) => row._id)).toEqual(['c_2']);
	});
});

describe('sort', () => {
	it('opens on email, ascending, by default', () => {
		const { table } = setup([member(2), member(1), member(3)]);
		expect(table.sortBy.value).toBe('email');
		expect(table.sortOrder.value).toBe('asc');
		expect(table.pageRows.value.map((row) => row._id)).toEqual(['c_1', 'c_2', 'c_3']);
	});

	it('opens a date default newest first', () => {
		const { table } = setup([member(2), member(1), member(3)], 'Exhausted', {
			defaultSort: 'addedAt',
		});
		expect(table.sortOrder.value).toBe('desc');
		expect(table.pageRows.value.map((row) => row._id)).toEqual(['c_3', 'c_2', 'c_1']);
	});

	it('opens the date column newest first when switched to, and a name column A to Z', () => {
		const { table } = setup([member(1), member(2)]);
		table.toggleSort('addedAt');
		expect(table.sortOrder.value).toBe('desc');
		table.toggleSort('firstName');
		expect(table.sortOrder.value).toBe('asc');
	});

	it('sorts a missing name before any name', () => {
		const { table } = setup([
			member(1, { lastName: 'Zuse' }),
			member(2),
			member(3, { lastName: 'Byron' }),
		]);
		table.toggleSort('lastName');
		expect(table.pageRows.value.map((row) => row._id)).toEqual(['c_2', 'c_3', 'c_1']);
	});

	it('ignores a column that is not one of the four', () => {
		const { table } = setup([member(1)]);
		expect(table.isSortable('phone')).toBe(false);
		table.toggleSort('phone');
		expect(table.sortBy.value).toBe('email');
	});
});

describe('paging', () => {
	const many = Array.from({ length: 60 }, (_, i) => member(i + 1));

	it('shows 25 rows a page with the range and the page numbers', () => {
		const { table } = setup(many);
		expect(table.pageRows.value).toHaveLength(25);
		expect(table.totalPages.value).toBe(3);
		expect(table.pageNumbers.value).toEqual([1, 2, 3]);
		expect(table.showingRange.value).toEqual({ start: 1, end: 25, total: 60 });

		table.goToPage(3);
		expect(table.pageRows.value).toHaveLength(10);
		expect(table.showingRange.value).toEqual({ start: 51, end: 60, total: 60 });

		table.goToPage(4);
		expect(table.currentPage.value).toBe(3);
	});

	it('reports no range when nothing matches', () => {
		const { table } = setup([]);
		expect(table.showingRange.value).toBeNull();
		expect(table.totalPages.value).toBe(1);
	});

	it('goes back to page 1 on a new sort', async () => {
		const { table } = setup(many);
		table.goToPage(3);
		table.toggleSort('addedAt');
		await nextTick();
		expect(table.currentPage.value).toBe(1);
	});

	it('goes back to page 1 on a new search', async () => {
		vi.useFakeTimers();
		const { table } = setup(many);
		table.goToPage(2);
		await search(table, 'user0');
		expect(table.currentPage.value).toBe(1);
	});
});

describe('loading more server pages', () => {
	it('asks for more while fewer rows are loaded than the next page needs', () => {
		const { paginated } = setup([member(1)], 'CanLoadMore');
		expect(paginated.loadMore).toHaveBeenCalledWith(50);
	});

	it('waits while the loaded window still covers the next page', async () => {
		const rows = Array.from({ length: 100 }, (_, i) => member(i + 1));
		const { paginated, table } = setup(rows, 'CanLoadMore');
		expect(paginated.loadMore).not.toHaveBeenCalled();

		// Page 3 needs rows up to 100 (page 4's end): still covered.
		table.goToPage(3);
		await nextTick();
		expect(paginated.loadMore).not.toHaveBeenCalled();

		table.goToPage(4);
		await nextTick();
		expect(paginated.loadMore).toHaveBeenCalledWith(50);
	});

	it('keeps loading while a search is active, however much is loaded', async () => {
		vi.useFakeTimers();
		const rows = Array.from({ length: 100 }, (_, i) => member(i + 1));
		const { paginated, table } = setup(rows, 'CanLoadMore');
		await search(table, 'someone');
		expect(paginated.loadMore).toHaveBeenCalledTimes(1);

		paginated.status.value = 'LoadingMore';
		await nextTick();
		paginated.status.value = 'CanLoadMore';
		await nextTick();
		expect(paginated.loadMore).toHaveBeenCalledTimes(2);
	});

	it('never asks once the query is exhausted', async () => {
		vi.useFakeTimers();
		const { paginated, table } = setup([member(1)], 'Exhausted');
		await search(table, 'x');
		expect(paginated.loadMore).not.toHaveBeenCalled();
	});
});
