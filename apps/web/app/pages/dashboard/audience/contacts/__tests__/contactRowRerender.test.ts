// @vitest-environment happy-dom
/**
 * Selecting one contact re-renders one table row (plan 3.7).
 *
 * The table used to be an inline `v-for` that read the selection set per row
 * and built a fresh right-click menu array for every row on every render, so
 * one checkbox click redrew the whole loaded page (hundreds of rows after a few
 * "Load more"s). Rows are now `ContactsContactRow` with a boolean `selected`
 * prop and a menu getter, so only the row whose value flips re-renders.
 *
 * Row renders are counted through `formatDate`, which each row calls once per
 * render for its "Created" cell and which nothing else in the table calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import ContactsIndex from '../index.vue';
import ContactRow from '~/components/contacts/ContactRow.vue';
import UiContextMenu from '@owlat/ui/components/ui/ContextMenu.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { useBulkOperation } from '~/composables/useBulkOperation';
import { useBulkSelection } from '~/composables/useBulkSelection';
import { useClickOutside } from '~/composables/useClickOutside';
import { useContactBulkOperations } from '~/composables/useContactBulkOperations';
import { useCsvImport } from '~/composables/useCsvImport';
import { useDataTable } from '~/composables/useDataTable';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useFormModal } from '~/composables/useFormModal';

const ROWS = 25;
const contacts = Array.from({ length: ROWS }, (_, i) => ({
	_id: `contact_${i}`,
	email: `person${i}@example.com`,
	firstName: `First${i}`,
	lastName: `Last${i}`,
	createdAt: i,
}));

const formatDate = vi.fn(() => 'Mar 3, 2026');

beforeEach(() => {
	formatDate.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useBulkOperation,
		useBulkSelection,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		useContactBulkOperations,
		useCsvImport,
		useDataTable,
		useDebouncedSearch,
		useFormModal,
		useTopicsList: () => ({ results: ref([]), isLoading: ref(false), status: ref('Exhausted') }),
		useConvexQuery: () => queryResult(undefined),
		useOrganizationQuery: () => queryResult(undefined),
		usePaginatedQuery: () => paginatedResult(contacts),
	});
});

function mountPage() {
	return mount(ContactsIndex, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			// A template global (Nuxt auto-import), so it reaches the rows as a mock.
			mocks: { formatDate },
			components: {
				UiQueryBoundary: QueryBoundary,
				ContactsContactRow: ContactRow,
				UiContextMenu,
			},
			stubs: {
				Icon: true,
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

describe('audience contacts table', () => {
	it('renders one ContactsContactRow per loaded contact', () => {
		const wrapper = mountPage();
		expect(wrapper.findAllComponents(ContactRow)).toHaveLength(ROWS);
		expect(formatDate).toHaveBeenCalledTimes(ROWS);
		wrapper.unmount();
	});

	it('re-renders only the toggled row when a checkbox is clicked', async () => {
		const wrapper = mountPage();
		formatDate.mockClear();

		await wrapper.get('button[aria-label="Select person3@example.com"]').trigger('click');
		await nextTick();

		expect(formatDate).toHaveBeenCalledTimes(1);
		const rows = wrapper.findAllComponents(ContactRow);
		expect(rows[3]?.props('selected')).toBe(true);
		expect(rows.filter((row) => row.props('selected'))).toHaveLength(1);

		formatDate.mockClear();
		await wrapper.get('button[aria-label="Deselect person3@example.com"]').trigger('click');
		await nextTick();
		expect(formatDate).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it('selects a row from its right-click menu through the same path', async () => {
		const wrapper = mountPage();
		await wrapper.findAll('tbody tr')[5]?.trigger('contextmenu', { clientX: 5, clientY: 5 });
		const select = Array.from(
			document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
		).find((el) => el.textContent?.trim() === 'Select');
		select?.click();
		await nextTick();

		expect(wrapper.findAllComponents(ContactRow)[5]?.props('selected')).toBe(true);
		wrapper.unmount();
	});
});
