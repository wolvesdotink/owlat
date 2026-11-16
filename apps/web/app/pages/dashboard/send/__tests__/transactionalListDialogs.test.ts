/**
 * The transactional list shows one dialog at a time. `?action=create` can
 * arrive while another dialog is up, or in the same address as `?sender=edit`,
 * and must leave only the create dialog open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, reactive, ref, type Ref } from 'vue';
import { hasPermission, type Permission } from '@owlat/shared/organizationPermissions';

import TransactionalIndex from '../transactional/index.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs } from '~/__tests__/a11y';

const EMAIL = {
	_id: 'e1',
	name: 'Order confirmation',
	slug: 'order-confirmation',
	subject: 'Your order',
	status: 'published',
	updatedAt: 1,
};

let route: { path: string; query: Record<string, string> };
let replace: ReturnType<typeof vi.fn>;
// The list composable's delete confirmation, which the shell renders.
let isDeleteOpen: Ref<boolean>;
let isDeleting: Ref<boolean>;

beforeEach(() => {
	isDeleteOpen = ref(false);
	isDeleting = ref(false);
	route = reactive({ path: '/dashboard/send/transactional', query: {} });
	replace = vi.fn(({ query }: { query: Record<string, string> }) => {
		route.query = query;
		return Promise.resolve();
	});
});

function render(role: 'owner' | 'editor' = 'owner'): VueWrapper {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => route,
		useRouter: () => ({ push: vi.fn(), replace }),
		usePermissions: () => ({
			isRoleLoading: ref(false),
			can: (permission: Permission) => hasPermission(role, permission),
			showGateFor: () => false,
		}),
		useTemplateList: () => ({
			items: ref([EMAIL]),
			searchQuery: ref(''),
			debouncedSearch: ref(''),
			viewMode: ref('list'),
			currentSort: ref({ value: 'updated' }),
			sortOptions: [],
			isLoading: ref(false),
			isEmpty: ref(false),
			error: ref(null),
			hasOrganization: ref(true),
			isDeleteOpen,
			isDeleting,
			deleteTarget: ref(null),
			// As `useListPage` does: a delete in flight keeps its dialog.
			closeDelete: () => {
				if (!isDeleting.value) isDeleteOpen.value = false;
			},
		}),
	});
	return mount(TransactionalIndex, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				ListPageShell: {
					props: ['deleteOpen'],
					template: `<div><div data-dialog="delete" :data-open="String(deleteOpen)" /><slot name="table" /><slot /></div>`,
				},
				LazyDeliveryTransactionalReadinessLine: true,
				SendTemplateGrid: true,
				SendTemplateCardList: true,
				SendTemplateStatusBadge: true,
				UiButton: true,
				UiSegmentedControl: true,
				// One button per row action, so a test opens a dialog the way a row does.
				SendTemplateTable: {
					props: ['items', 'actions'],
					template: `<div><button v-for="action in actions" :key="action.key" :data-action="action.key" @click="action.run(items[0])" /></div>`,
				},
				TransactionalCreateEmailModal: {
					props: ['open'],
					template: '<div data-dialog="create" :data-open="String(open)" />',
				},
				LazyTransactionalSenderDialog: {
					props: ['open'],
					template: '<div data-dialog="sender" :data-open="String(open)" />',
				},
				TransactionalApiSnippetModal: {
					props: ['email'],
					template: '<div data-dialog="snippet" :data-open="String(email !== null)" />',
				},
				TransactionalRecentSendsModal: {
					props: ['open'],
					template: '<div data-dialog="sends" :data-open="String(open)" />',
				},
			},
		},
	}) as VueWrapper;
}

/** The dialogs that are open, by name. A dialog that never mounted is closed. */
function openDialogs(wrapper: VueWrapper): string[] {
	return wrapper
		.findAll('[data-dialog][data-open="true"]')
		.map((dialog) => dialog.attributes('data-dialog')!);
}

describe('transactional list dialogs', () => {
	it('opens only the create dialog when the address also asks for the sender dialog', async () => {
		route.query = { sender: 'edit', action: 'create' };
		const wrapper = render();
		await nextTick();

		expect(openDialogs(wrapper)).toEqual(['create']);
		expect(replace).toHaveBeenLastCalledWith({ query: {} });
		expect(route.query).toEqual({});
	});

	it('closes the API snippet when a create action arrives', async () => {
		const wrapper = render();
		await wrapper.find('[data-action="api-code"]').trigger('click');
		expect(openDialogs(wrapper)).toEqual(['snippet']);

		route.query = { action: 'create' };
		await nextTick();

		expect(openDialogs(wrapper)).toEqual(['create']);
	});

	it('closes the recent sends when a create action arrives', async () => {
		const wrapper = render();
		await wrapper.find('[data-action="sends"]').trigger('click');
		expect(openDialogs(wrapper)).toEqual(['sends']);

		route.query = { action: 'create' };
		await nextTick();

		expect(openDialogs(wrapper)).toEqual(['create']);
	});

	it('closes an idle delete confirmation when a create action arrives', async () => {
		const wrapper = render();
		isDeleteOpen.value = true;
		await nextTick();
		expect(openDialogs(wrapper)).toEqual(['delete']);

		route.query = { action: 'create' };
		await nextTick();

		expect(openDialogs(wrapper)).toEqual(['create']);
	});

	it('waits for a running delete, then opens the create dialog', async () => {
		const wrapper = render();
		isDeleteOpen.value = true;
		isDeleting.value = true;
		route.query = { action: 'create' };
		await nextTick();

		expect(openDialogs(wrapper)).toEqual(['delete']);
		expect(route.query).toEqual({ action: 'create' });

		isDeleteOpen.value = false;
		isDeleting.value = false;
		await nextTick();

		expect(openDialogs(wrapper)).toEqual(['create']);
		expect(route.query).toEqual({});
	});

	it('keeps the sender dialog closed while the create dialog is open', async () => {
		route.query = { action: 'create' };
		const wrapper = render();
		await nextTick();

		route.query = { sender: 'edit' };
		await nextTick();

		expect(openDialogs(wrapper)).toEqual(['create']);
	});

	it('drops the action and opens nothing for a member who cannot create', async () => {
		route.query = { status: 'draft', action: 'create' };
		const wrapper = render('editor');
		await nextTick();

		expect(openDialogs(wrapper)).toEqual([]);
		expect(route.query).toEqual({ status: 'draft' });
	});
});
