// @vitest-environment happy-dom
/**
 * The contacts table announces its sort (plan OW-038). The Created header's
 * chevron was the only cue to whether the loaded audience is newest- or
 * oldest-first; screen readers got nothing. Exactly one header now carries
 * `aria-sort`, and its value is checked against the args the page actually
 * sends to `contacts.list`, so announcement and query cannot drift apart.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

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

type ListArgs = { sort: string; order: 'asc' | 'desc' };
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

function expectOneTruthfulAriaSort(wrapper: ReturnType<typeof mountPage>) {
	const sorted = wrapper.findAll('thead th').filter((th) => th.attributes('aria-sort'));
	expect(sorted).toHaveLength(1);
	const [th] = sorted;
	// The header that announces the sort is the one whose button drives it.
	expect(th?.find('button').element).toBe(createdSortButton(wrapper).element);
	expect(listArgs().sort).toBe('createdAt');
	expect(th?.attributes('aria-sort')).toBe(ARIA_SORT[listArgs().order]);
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
});
