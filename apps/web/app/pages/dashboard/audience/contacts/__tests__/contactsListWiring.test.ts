/**
 * The contacts list, through its pieces: the Import menu, the bulk bar with
 * its Actions menu, and the Add contact modal. The pieces render and emit;
 * the page owns the selection, the bulk operations and the modals' open
 * state, so these cases drive the real page composables.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';

import ContactsIndex from '../index.vue';
import ContactRow from '~/components/contacts/ContactRow.vue';
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

const contacts = Array.from({ length: 3 }, (_, i) => ({
	_id: `contact_${i}`,
	email: `person${i}@example.com`,
	createdAt: i,
}));
const TOPICS = [
	{ _id: 'tp_news', name: 'Newsletter' },
	{ _id: 'tp_beta', name: 'Beta program' },
];

const ops: Record<string, ReturnType<typeof vi.fn>> = {};

const ModalStub = defineComponent({
	props: { open: { type: Boolean, default: false } },
	emits: ['update:open'],
	template: '<section v-if="open" role="dialog"><slot /><slot name="footer" /></section>',
});

beforeEach(() => {
	for (const key of Object.keys(ops)) delete ops[key];
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
		useTopicsList: () => ({
			results: ref(TOPICS),
			isLoading: ref(false),
			status: ref('Exhausted'),
		}),
		useConvexQuery: () => queryResult(undefined),
		useOrganizationQuery: () => queryResult(undefined),
		usePaginatedQuery: () => paginatedResult(contacts),
		useBackendOperation: (_fn: unknown, options: { label: () => string }) => {
			const run = vi.fn(async () => ({ ok: true }));
			ops[options.label()] = run;
			return { run, isLoading: ref(false) };
		},
	});
});

function mountPage() {
	return mount(ContactsIndex, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			mocks: { formatDate: () => 'Mar 3, 2026' },
			components: { UiQueryBoundary: QueryBoundary, ContactsContactRow: ContactRow },
			stubs: {
				UiModal: ModalStub,
				UiPageHeader: { template: '<header><slot name="actions" /></header>' },
				AudienceTabs: true,
				UiInput: {
					props: ['modelValue', 'label', 'error'],
					emits: ['update:modelValue'],
					template:
						'<label>{{ label }}<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><em v-if="error">{{ error }}</em></label>',
				},
				UiSelect: true,
				UiButton: { template: '<button v-bind="$attrs"><slot /></button>', inheritAttrs: false },
				UiTooltip: { template: '<span><slot /></span>' },
				UiContextMenu: { template: '<div><slot /></div>' },
				UiSpinner: true,
				UiEmptyState: true,
				DashboardListSkeleton: true,
				LazyContactsCsvImportModal: {
					props: ['csvImport'],
					template: '<div v-if="csvImport.isOpen.value" data-testid="csv-import" />',
				},
				LazyContactsExportModal: true,
				LazyContactsIntegrationImportModal: {
					props: ['open'],
					template: '<div v-if="open" data-testid="integration-import" />',
				},
				LazyContactsBulkDeleteModal: true,
			},
		},
	});
}

const button = (scope: ReturnType<typeof mountPage>, label: string) =>
	scope.findAll('button').find((candidate) => candidate.text().trim() === label);

describe('contacts list pieces', () => {
	it('opens the CSV and the integration import from the Import menu', async () => {
		const wrapper = mountPage();
		expect(wrapper.text()).not.toContain('CSV file');
		await button(wrapper, 'Import')!.trigger('click');
		await button(wrapper, 'CSV fileImport from spreadsheet')!.trigger('click');
		expect(wrapper.find('[data-testid="csv-import"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Import from spreadsheet');

		await button(wrapper, 'Import')!.trigger('click');
		await button(wrapper, 'IntegrationsMailchimp, Stripe')!.trigger('click');
		expect(wrapper.find('[data-testid="integration-import"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('shows the bulk bar for a selection, and a click outside closes its menus', async () => {
		const wrapper = mountPage();
		expect(wrapper.text()).not.toContain('1 selected');
		await wrapper.get('input[aria-label="Select person1@example.com"]').trigger('click');
		await nextTick();
		expect(wrapper.text()).toContain('1 selected');

		await button(wrapper, 'Actions')!.trigger('click');
		await wrapper
			.findAll('button')
			.find((b) => b.text().includes('Add to topic'))!
			.trigger('click');
		expect(button(wrapper, 'Beta program')).toBeDefined();

		document.body.click();
		await nextTick();
		expect(wrapper.text()).not.toContain('Delete selected');
		expect(button(wrapper, 'Beta program')).toBeUndefined();

		await wrapper.get('button[aria-label="Clear selection"]').trigger('click');
		await nextTick();
		expect(wrapper.text()).not.toContain('1 selected');
		wrapper.unmount();
	});

	it('validates the new contact, then creates it with trimmed fields', async () => {
		const wrapper = mountPage();
		await button(wrapper, 'Add contact')!.trigger('click');
		const dialog = () => wrapper.get('[role="dialog"]');
		await button(wrapper, 'Create contact')!.trigger('click');
		expect(dialog().text()).toContain('Email is required');
		expect(ops['Add contact']).not.toHaveBeenCalled();

		const [email, first] = dialog().findAll('input');
		await email!.setValue('  ada@owlat.example ');
		await first!.setValue(' Ada ');
		await dialog().get('form').trigger('submit');
		await flushPromises();
		expect(ops['Add contact']).toHaveBeenCalledWith({
			email: 'ada@owlat.example',
			firstName: 'Ada',
			lastName: undefined,
			language: undefined,
			source: 'form',
		});
		expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
