// @vitest-environment happy-dom
/**
 * `useListPage` is the state half of the list-page scaffold: search, sort, the
 * delete-confirmation dialog and the `n` / Escape shortcuts.
 *
 * The regression it closes: the transactional list cleared its search by
 * writing both refs from the template, and `debouncedSearch` is readonly — the
 * second write was rejected with a warning, so the rows only reset once the
 * 300 ms debounce fired. The marketing list registered `n` and Escape; the
 * transactional list registered neither.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { withSetup } from '~/__tests__/withSetup';
import type { UseListPageOptions } from '../useListPage';

type Handler = () => void;

const registered = new Map<string, Handler>();
const unregisterShortcut = vi.fn((id: string) => registered.delete(id));

vi.mock('../useKeyboardShortcuts', () => ({
	useKeyboardShortcuts: () => ({
		registerNewShortcut: (handler: Handler) => registered.set('global.newItem', handler),
		registerEscapeHandler: (handler: Handler) => registered.set('global.close', handler),
		unregisterShortcut,
	}),
}));

const { useListPage } = await import('../useListPage');

const SORTS = [
	{ value: 'updatedAt-desc', label: 'shared.templateList.sort.updatedDesc' },
	{ value: 'name-asc', label: 'shared.templateList.sort.nameAsc' },
] as const;

type Sort = (typeof SORTS)[number];
type Item = { id: string; name: string };

function setup(overrides: Partial<UseListPageOptions<Sort, Item>> = {}) {
	const onDelete = vi.fn(async (_item: Item): Promise<boolean> => true);
	const mounted = withSetup(() =>
		useListPage<Sort, Item>({ sortOptions: SORTS, onDelete, ...overrides })
	);
	return { ...mounted, onDelete };
}

beforeEach(() => {
	// `useConfirmModal` only reaches for `t` on an error it never hits here.
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	registered.clear();
	unregisterShortcut.mockClear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('search', () => {
	it('debounces the typed query', async () => {
		const { result } = setup();
		result.searchQuery.value = 'welcome';
		await nextTick();
		expect(result.debouncedSearch.value).toBe('');
		vi.advanceTimersByTime(300);
		expect(result.debouncedSearch.value).toBe('welcome');
	});

	it('clears both refs synchronously, without writing the readonly one', async () => {
		const warn = vi.spyOn(console, 'warn');
		const { result } = setup();
		result.searchQuery.value = 'welcome';
		await nextTick();
		vi.advanceTimersByTime(300);
		expect(result.debouncedSearch.value).toBe('welcome');

		result.clearSearch();
		expect(result.searchQuery.value).toBe('');
		expect(result.debouncedSearch.value).toBe('');
		// A pending debounce from the cleared input must not resurrect the term.
		await nextTick();
		vi.advanceTimersByTime(300);
		expect(result.debouncedSearch.value).toBe('');
		expect(warn.mock.calls.flat().map(String).join('\n')).not.toContain('readonly');
		warn.mockRestore();
	});
});

describe('sort', () => {
	it('opens on the first option, or on defaultSort', () => {
		expect(setup().result.currentSort.value.value).toBe('updatedAt-desc');
		expect(setup({ defaultSort: 'name-asc' }).result.currentSort.value.value).toBe('name-asc');
	});

	it('selects a known option and ignores an unknown value', () => {
		const { result } = setup();
		result.selectSort('name-asc');
		expect(result.currentSort.value).toEqual(SORTS[1]);
		result.selectSort('bogus');
		expect(result.currentSort.value).toEqual(SORTS[1]);
	});
});

describe('delete confirmation', () => {
	const item: Item = { id: 't1', name: 'Welcome' };

	it('opens on an item and closes on cancel', () => {
		const { result } = setup();
		result.openDelete(item);
		expect(result.isDeleteOpen.value).toBe(true);
		expect(result.deleteTarget.value).toEqual(item);
		result.closeDelete();
		expect(result.isDeleteOpen.value).toBe(false);
		expect(result.deleteTarget.value).toBeNull();
	});

	it('is busy while the delete runs, ignores cancel meanwhile, then closes', async () => {
		let resolve!: (ok: boolean) => void;
		const onDelete = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
		const { result } = setup({ onDelete });
		result.openDelete(item);

		const pending = result.confirmDelete();
		expect(onDelete).toHaveBeenCalledWith(item);
		expect(result.isDeleting.value).toBe(true);
		result.closeDelete();
		expect(result.isDeleteOpen.value).toBe(true);
		// A second confirm while busy does not fire a second delete.
		await result.confirmDelete();
		expect(onDelete).toHaveBeenCalledTimes(1);

		resolve(true);
		await pending;
		expect(result.isDeleting.value).toBe(false);
		expect(result.isDeleteOpen.value).toBe(false);
	});

	it('stays open when the delete failed', async () => {
		const { result } = setup({ onDelete: vi.fn(async () => false) });
		result.openDelete(item);
		await result.confirmDelete();
		expect(result.isDeleteOpen.value).toBe(true);
		expect(result.isDeleting.value).toBe(false);
	});
});

describe('shortcuts', () => {
	it('registers n and Escape on mount and releases both on unmount', () => {
		const { unmount } = setup({ onNew: vi.fn() });
		expect([...registered.keys()].sort()).toEqual(['global.close', 'global.newItem']);
		unmount();
		expect(unregisterShortcut).toHaveBeenCalledWith('global.newItem');
		expect(unregisterShortcut).toHaveBeenCalledWith('global.close');
		expect(registered.size).toBe(0);
	});

	it('n creates only when allowed and nothing else owns the page', () => {
		const onNew = vi.fn();
		const canCreate = ref(false);
		const isBusy = ref(false);
		const { result } = setup({ onNew, canCreate, isBusy });
		const press = () => registered.get('global.newItem')!();

		press();
		expect(onNew).not.toHaveBeenCalled();
		canCreate.value = true;
		press();
		expect(onNew).toHaveBeenCalledTimes(1);
		isBusy.value = true;
		press();
		expect(onNew).toHaveBeenCalledTimes(1);
		isBusy.value = false;
		result.openDelete({ id: 't1', name: 'Welcome' });
		press();
		expect(onNew).toHaveBeenCalledTimes(1);
	});

	it('Escape defers to the page, then closes an idle delete dialog', () => {
		let pageHandles = true;
		const onEscape = vi.fn(() => pageHandles);
		const { result } = setup({ onEscape });
		const press = () => registered.get('global.close')!();
		result.openDelete({ id: 't1', name: 'Welcome' });

		press();
		expect(onEscape).toHaveBeenCalledTimes(1);
		expect(result.isDeleteOpen.value).toBe(true);
		pageHandles = false;
		press();
		expect(result.isDeleteOpen.value).toBe(false);
	});
});
