// @vitest-environment happy-dom
/**
 * Contacts without an email keep a nonempty identity on the list page
 * (plan OW-037), in both the table and the card list below `md`.
 *
 * `contacts.email` is optional, so a row used to render a blank primary cell
 * and a checkbox named "Select " for such a contact. The page now shows the
 * email, else the full name, else "Unnamed contact", and names the checkbox
 * after the same identity. The card list adds the name as a second line only
 * when the email is the first one, so a named email-less card does not repeat
 * its name.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

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
import { useContactCsvImportOperations } from '~/composables/useContactCsvImportOperations';
import { useCsvImport } from '~/composables/useCsvImport';
import { useDataTable } from '~/composables/useDataTable';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useFormModal } from '~/composables/useFormModal';

const contacts = [
	{
		_id: 'c_email',
		email: 'ada@example.com',
		firstName: 'Ada',
		lastName: 'Lovelace',
		createdAt: 3,
	},
	{ _id: 'c_named', firstName: 'Grace', lastName: 'Hopper', createdAt: 2 },
	{ _id: 'c_unnamed', firstName: null, lastName: null, createdAt: 1 },
];
const IDENTITIES = ['ada@example.com', 'Grace Hopper', 'Unnamed contact'];

function mountPage(tableFits: boolean) {
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
		useDataTableViewport: () => ref(tableFits),
		useDebouncedSearch,
		useFormModal,
		useTopicsList: () => ({ results: ref([]), isLoading: ref(false), status: ref('Exhausted') }),
		useConvexQuery: () => queryResult(undefined),
		useOrganizationQuery: () => queryResult(undefined),
		usePaginatedQuery: () => paginatedResult(contacts),
	});
	return mount(ContactsIndex, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			mocks: { formatDate: () => 'Mar 3, 2026' },
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

describe('contacts list identity for email-less contacts', () => {
	it('shows and announces a nonempty identity in every table row', () => {
		const wrapper = mountPage(true);
		const rows = wrapper.findAll('tbody tr');
		expect(rows).toHaveLength(3);
		for (const [i, row] of rows.entries()) {
			const label = IDENTITIES[i]!;
			expect(row.findAll('td')[1]?.text()).toBe(label);
			expect(row.find('button').attributes('aria-label')).toBe(`Select ${label}`);
		}
		wrapper.unmount();
	});

	it('shows and announces the same identity on every card', () => {
		const wrapper = mountPage(false);
		expect(wrapper.find('table').exists()).toBe(false);
		const cards = wrapper.findAll('li');
		expect(cards).toHaveLength(3);
		for (const [i, card] of cards.entries()) {
			const label = IDENTITIES[i]!;
			const [select, open] = card.findAll('button');
			expect(select?.attributes('aria-label')).toBe(`Select ${label}`);
			expect(open?.findAll('span')[0]?.text()).toBe(label);
		}
		// The name line follows an email, and is not repeated under a name.
		expect(cards[0]?.text()).toContain('Ada Lovelace');
		expect(cards[1]?.text().match(/Grace Hopper/g)).toHaveLength(1);
		wrapper.unmount();
	});
});
