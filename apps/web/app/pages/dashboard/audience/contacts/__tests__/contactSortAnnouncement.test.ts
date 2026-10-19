// @vitest-environment happy-dom
/**
 * The contacts table announces its sort (plan OW-038). The Created header's
 * chevron was the only cue to whether the loaded audience is newest- or
 * oldest-first; screen readers got nothing. Exactly one header now carries
 * `aria-sort`, and its value is checked against the args the page actually
 * sends to `contacts.list`, so announcement and query cannot drift apart.
 * A search is relevance-ordered and the backend ignores sort/order on it, so
 * while one is active no header claims a sort.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import ContactsIndex from '../index.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { useBulkOperation } from '~/composables/useBulkOperation';
import { useBulkSelection } from '~/composables/useBulkSelection';
import { useClickOutside } from '~/composables/useClickOutside';
import { useContactBulkOperations } from '~/composables/useContactBulkOperations';
import { useContactCsvImportOperations } from '~/composables/useContactCsvImportOperations';
import { useCsvImport } from '~/composables/useCsvImport';
import { useDataTable } from '~/composables/useDataTable';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useFormModal } from '~/composables/useFormModal';

const contacts = [{ _id: 'contact_0', email: 'person0@example.com', createdAt: 0 }];

type ListArgs = { search?: string; sort: string; order: 'asc' | 'desc' };
let listArgs: () => ListArgs;

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		useBulkOperation,
		useBulkSelection,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		useContactBulkOperations,
		useContactCsvImportOperations,
		useCsvImport,
		useDataTable,
		useDebouncedSearch,
		useFormModal,
		useTopicsList: () => ({ results: ref([]), isLoading: ref(false), status: ref('Exhausted') }),
		useConvexQuery: () => queryResult(undefined),
		useOrganizationQuery: () => queryResult(undefined),
		usePaginatedQuery: (_query: unknown, args: () => ListArgs) => {
			listArgs = args;
			return paginatedResult(contacts);
		},
	});
});

afterEach(() => {
	vi.useRealTimers();
});

function mountPage() {
	return mount(ContactsIndex, {
		global: {
			plugins: [createTestI18n()],
			components: { UiQueryBoundary: QueryBoundary },
			stubs: {
				Icon: true,
				ContactsContactRow: true,
				UiModal: true,
				UiPageHeader: true,
				AudienceTabs: true,
				UiInput: true,
				UiSelect: true,
				UiButton: true,
				UiErrorAlert: true,
				UiSpinner: true,
				UiEmptyState: true,
				DashboardListSkeleton: true,
				LazyContactsCsvImportModal: true,
				LazyContactsExportModal: true,
				LazyContactsIntegrationImportModal: true,
				LazyContactsBulkDeleteModal: true,
			},
		},
	});
}

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;

const createdSortButton = (wrapper: ReturnType<typeof mountPage>) =>
	wrapper.findAll('thead th button').find((button) => button.text() === 'Created')!;

const sortedHeaders = (wrapper: ReturnType<typeof mountPage>) =>
	wrapper.findAll('thead th').filter((th) => th.attributes('aria-sort') !== undefined);

/** The text the Created button's aria-describedby points at. */
function sortHint(wrapper: ReturnType<typeof mountPage>) {
	const id = createdSortButton(wrapper).attributes('aria-describedby');
	return wrapper.get(`#${id}`).text();
}

function expectOneTruthfulAriaSort(wrapper: ReturnType<typeof mountPage>) {
	const sorted = sortedHeaders(wrapper);
	expect(sorted).toHaveLength(1);
	const [th] = sorted;
	// The header that announces the sort is the one whose button drives it.
	expect(th?.find('button').element).toBe(createdSortButton(wrapper).element);
	expect(listArgs().search).toBeUndefined();
	expect(listArgs().sort).toBe('createdAt');
	expect(th?.attributes('aria-sort')).toBe(ARIA_SORT[listArgs().order]);
	expect(sortHint(wrapper)).toBe('Sort contacts by creation date');
}

async function search(wrapper: ReturnType<typeof mountPage>, query: string) {
	wrapper.findComponent({ name: 'UiInput' }).vm.$emit('update:modelValue', query);
	await nextTick();
	// Past the 300 ms search debounce, so the query args change.
	vi.advanceTimersByTime(300);
	await nextTick();
}

describe('contacts table sort announcement', () => {
	it('marks exactly one header with the direction sent to the query', async () => {
		const wrapper = mountPage();
		expect(wrapper.findAll('thead th').length).toBeGreaterThan(1);

		// Default: newest first.
		expectOneTruthfulAriaSort(wrapper);
		expect(listArgs().order).toBe('desc');

		await createdSortButton(wrapper).trigger('click');
		expectOneTruthfulAriaSort(wrapper);
		expect(listArgs().order).toBe('asc');

		await createdSortButton(wrapper).trigger('click');
		expectOneTruthfulAriaSort(wrapper);
		expect(listArgs().order).toBe('desc');
		wrapper.unmount();
	});

	it('claims no sort while a relevance-ordered search is active', async () => {
		vi.useFakeTimers();
		const wrapper = mountPage();
		expectOneTruthfulAriaSort(wrapper);

		await search(wrapper, 'person');
		expect(listArgs().search).toBe('person');
		expect(sortedHeaders(wrapper)).toHaveLength(0);
		expect(createdSortButton(wrapper).find('icon-stub').exists()).toBe(false);
		expect(sortHint(wrapper)).toBe('Search results are ordered by relevance');

		// The control is inert but stays focusable, and says why on hover too.
		const button = createdSortButton(wrapper);
		expect(button.attributes('aria-disabled')).toBe('true');
		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('title')).toBe('Search results are ordered by relevance');
		await button.trigger('click');
		expect(listArgs().order).toBe('desc');
		expect(sortedHeaders(wrapper)).toHaveLength(0);

		// Whitespace is no search: the backend trims it and sorts by date.
		await search(wrapper, '   ');
		expect(sortedHeaders(wrapper)).toHaveLength(1);

		await search(wrapper, '');
		// The click during the search left the stored direction alone.
		expect(listArgs().order).toBe('desc');
		expectOneTruthfulAriaSort(wrapper);
		expect(createdSortButton(wrapper).find('icon-stub').exists()).toBe(true);
		expect(createdSortButton(wrapper).attributes('aria-disabled')).toBeUndefined();
		expect(createdSortButton(wrapper).attributes('title')).toBeUndefined();
		wrapper.unmount();
	});
});
