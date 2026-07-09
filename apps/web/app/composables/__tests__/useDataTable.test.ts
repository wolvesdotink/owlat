/**
 * useDataTable — the shared list-table contract the three Audience list pages
 * (Contacts, Topics, Segments) now converge on. The load-bearing guarantee this
 * suite locks in is HONESTY: the columns a page *declares* sortable are exactly
 * the columns that render a sort affordance. Because every page derives its
 * header affordance from `isSortable`/`getSortIcon`, "declared sortable" can
 * never drift from "rendered sortable".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { useDebouncedSearch } from '../useDebouncedSearch';
import { useDataTable } from '../useDataTable';

// useDataTable composes useDebouncedSearch, which Nuxt auto-imports at runtime.
beforeAll(() => {
	(globalThis as Record<string, unknown>)['useDebouncedSearch'] = useDebouncedSearch;
});

describe('useDataTable sortable-column contract', () => {
	it('marks exactly the declared columns as sortable', () => {
		const declared = ['name', 'contactCount', 'createdAt'] as const;
		const { isSortable } = useDataTable<(typeof declared)[number]>({
			defaultSort: 'createdAt',
			sortableFields: declared,
		});

		for (const field of declared) {
			expect(isSortable(field)).toBe(true);
		}
	});

	it('does not offer sort on an undeclared column', () => {
		const { isSortable } = useDataTable<'name' | 'createdAt'>({
			defaultSort: 'createdAt',
			sortableFields: ['createdAt'],
		});

		expect(isSortable('createdAt')).toBe(true);
		expect(isSortable('name')).toBe(false);
	});

	it('treats every column as sortable when none are declared (back-compat)', () => {
		const { isSortable } = useDataTable<'a' | 'b'>({ defaultSort: 'a' });
		expect(isSortable('a')).toBe(true);
		expect(isSortable('b')).toBe(true);
	});
});

describe('useDataTable getSortIcon', () => {
	it('shows a chevron only on the active sort column, direction-aware', () => {
		const { toggleSort, getSortIcon } = useDataTable<'name' | 'createdAt'>({
			defaultSort: 'createdAt',
			defaultOrder: 'desc',
			sortableFields: ['name', 'createdAt'],
		});

		// Active default column shows the desc chevron; the other shows nothing.
		expect(getSortIcon('createdAt')).toBe('lucide:chevron-down');
		expect(getSortIcon('name')).toBeNull();

		// Toggling to a new (non-date) column activates it ascending.
		toggleSort('name');
		expect(getSortIcon('name')).toBe('lucide:chevron-up');
		expect(getSortIcon('createdAt')).toBeNull();

		// Toggling the active column flips the direction.
		toggleSort('name');
		expect(getSortIcon('name')).toBe('lucide:chevron-down');
	});
});
