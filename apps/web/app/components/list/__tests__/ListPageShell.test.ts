// @vitest-environment happy-dom
/**
 * `ListPageShell` is the frame the dashboard list pages share. Mounted with the
 * real UI layer (header, empty states, segmented control, confirmation dialog)
 * so the assertions are about what a user gets, not about stubs:
 *   - below `md` exactly one of `#table` / `#cards` is mounted, never both;
 *   - the three empty states (no organization, nothing yet, no search results)
 *     and the clear-search control on the last;
 *   - the delete dialog names the item and routes confirm / cancel out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref, useSlots } from 'vue';

import ListPageShell from '../ListPageShell.vue';
import ListSortMenu from '../ListSortMenu.vue';
import UiPageHeader from '@owlat/ui/components/ui/PageHeader.vue';
import UiEmptyState from '@owlat/ui/components/ui/EmptyState.vue';
import UiConfirmationDialog from '@owlat/ui/components/ui/ConfirmationDialog.vue';
import UiSegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import UiCard from '@owlat/ui/components/ui/Card.vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const tableFits = ref(true);

beforeEach(() => {
	tableFits.value = true;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useSlots', useSlots);
	vi.stubGlobal('useDataTableViewport', () => tableFits);
	vi.stubGlobal('useClickOutsideSelector', vi.fn());
});

// The dialog's own wiring is the subject; the modal chrome (teleport, focus
// trap) is not, so it renders inline while open.
const UiModalStub = defineComponent({
	props: { open: Boolean, persistent: Boolean, closable: Boolean },
	emits: ['update:open'],
	setup(props, { slots, emit }) {
		return () =>
			props.open
				? h('div', { role: 'dialog' }, [
						h('button', { 'data-testid': 'backdrop', onClick: () => emit('update:open', false) }),
						slots.default?.(),
						slots.footer?.(),
					])
				: null;
	},
});

const UiQueryBoundaryStub = defineComponent({
	props: { loading: Boolean },
	setup(props, { slots }) {
		return () =>
			props.loading
				? h('div', { 'data-testid': 'loading' }, slots['loading']?.())
				: h('div', slots.default?.());
	},
});

const baseProps = {
	title: 'Marketing templates',
	loading: false,
	errorTitle: 'Could not load',
	loadingLabel: 'Loading',
	hasOrganization: true,
	isEmpty: false,
	search: '',
	activeSearch: '',
	searchPlaceholder: 'Search templates...',
	sortOptions: [
		{ value: 'updatedAt-desc', label: 'shared.templateList.sort.updatedDesc' },
		{ value: 'name-asc', label: 'shared.templateList.sort.nameAsc' },
	],
	sort: 'updatedAt-desc',
	sortLabel: 'Sort templates',
	sortListboxId: 'test-sort-listbox',
	viewMode: 'list' as const,
	emptyNoOrg: { icon: 'lucide:mail', title: 'No team selected', description: 'Pick a team.' },
	empty: { icon: 'lucide:mail', title: 'No templates yet', description: 'Create one.' },
	noResults: { title: 'No results found', description: 'Nothing matches.' },
	deleteCopy: {
		title: 'Delete template',
		confirmKeypath: 'dashboard.send.marketing.index.delete.confirm',
		description: 'This cannot be undone.',
		confirmText: 'Delete template',
	},
	deleteOpen: false,
	deleteName: '',
	isDeleting: false,
};

function render(props: Partial<typeof baseProps> = {}, extraSlots: Record<string, string> = {}) {
	return mount(ListPageShell, {
		props: { ...baseProps, ...props },
		slots: {
			table: '<table data-testid="table" />',
			cards: '<ul data-testid="cards" />',
			grid: '<div data-testid="grid" />',
			'empty-action': '<button data-testid="create">Create</button>',
			...extraSlots,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				ListSortMenu,
				UiPageHeader,
				UiEmptyState,
				UiConfirmationDialog,
				UiSegmentedControl,
				UiCard,
				UiInput,
			},
			stubs: { UiModal: UiModalStub, UiQueryBoundary: UiQueryBoundaryStub },
		},
	});
}

describe('ListPageShell', () => {
	it('renders the title as the page heading', () => {
		expect(render().get('h1').text()).toBe('Marketing templates');
	});

	it('mounts the table, and only the table, when the columns fit', () => {
		const wrapper = render();
		expect(wrapper.findAll('[data-testid="table"]')).toHaveLength(1);
		expect(wrapper.find('[data-testid="cards"]').exists()).toBe(false);
	});

	it('mounts the card list, and only the card list, below md', () => {
		tableFits.value = false;
		const wrapper = render();
		expect(wrapper.findAll('[data-testid="cards"]')).toHaveLength(1);
		expect(wrapper.find('[data-testid="table"]').exists()).toBe(false);
	});

	it('mounts the grid instead of either in grid view', () => {
		const wrapper = render({ viewMode: 'grid' });
		expect(wrapper.find('[data-testid="grid"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="table"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="cards"]').exists()).toBe(false);
	});

	it('switches view mode through labelled segments', async () => {
		const wrapper = render();
		const tabs = wrapper.findAll('[role="tab"]');
		expect(tabs.map((tab) => tab.text())).toEqual(['Grid view', 'List view']);
		await tabs[0]!.trigger('click');
		expect(wrapper.emitted('update:viewMode')).toEqual([['grid']]);
	});

	it('shows the spinner, not an empty state, while the first load runs', () => {
		const wrapper = render({ loading: true, isEmpty: true });
		expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true);
		expect(wrapper.find('h2').exists()).toBe(false);
	});

	it('passes a page skeleton to the first-load state', () => {
		const wrapper = render(
			{ loading: true, isEmpty: true },
			{ loading: '<div data-testid="skeleton" />' }
		);
		expect(wrapper.get('[data-testid="loading"]').find('[data-testid="skeleton"]').exists()).toBe(
			true
		);
	});

	it('renders a section tab bar above the heading', () => {
		const wrapper = render({}, { 'before-header': '<nav data-testid="tabs" />' });
		const html = wrapper.html();
		expect(html.indexOf('data-testid="tabs"')).toBeGreaterThan(-1);
		expect(html.indexOf('data-testid="tabs"')).toBeLessThan(html.indexOf('<h1'));
	});

	it('explains a missing organization before anything else', () => {
		const wrapper = render({ hasOrganization: false, isEmpty: true });
		expect(wrapper.get('h2').text()).toBe('No team selected');
		expect(wrapper.find('[data-testid="create"]').exists()).toBe(false);
	});

	it('offers the create action when there is nothing yet', () => {
		const wrapper = render({ isEmpty: true });
		expect(wrapper.get('h2').text()).toBe('No templates yet');
		expect(wrapper.find('[data-testid="create"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="table"]').exists()).toBe(false);
	});

	it('offers to clear a search that matched nothing', async () => {
		const wrapper = render({ isEmpty: true, search: 'zzz', activeSearch: 'zzz' });
		expect(wrapper.get('h2').text()).toBe('No results found');
		const clear = wrapper.findAll('button').find((b) => b.text() === 'Clear search');
		expect(clear).toBeDefined();
		await clear!.trigger('click');
		expect(wrapper.emitted('clear-search')).toHaveLength(1);
	});

	it('forwards the search input', async () => {
		const wrapper = render();
		await wrapper.get('input[type="text"]').setValue('welcome');
		expect(wrapper.emitted('update:search')).toEqual([['welcome']]);
	});

	describe('delete dialog', () => {
		it('stays closed until asked', () => {
			expect(render().find('[role="dialog"]').exists()).toBe(false);
		});

		it('names the item in bold and emits confirm', async () => {
			const wrapper = render({ deleteOpen: true, deleteName: 'Welcome' });
			const dialog = wrapper.get('[role="dialog"]');
			expect(dialog.text()).toContain('Delete template');
			expect(dialog.get('p span.font-semibold').text()).toBe('"Welcome"');
			expect(dialog.text()).toContain('This cannot be undone.');
			const confirm = dialog.findAll('button').find((b) => b.text() === 'Delete template');
			await confirm!.trigger('click');
			expect(wrapper.emitted('confirm-delete')).toHaveLength(1);
			expect(wrapper.emitted('cancel-delete')).toBeUndefined();
		});

		it('emits cancel from the Cancel button and the backdrop', async () => {
			const wrapper = render({ deleteOpen: true, deleteName: 'Welcome' });
			const cancel = wrapper.findAll('button').find((b) => b.text() === 'Cancel');
			await cancel!.trigger('click');
			await wrapper.get('[data-testid="backdrop"]').trigger('click');
			expect(wrapper.emitted('cancel-delete')).toHaveLength(2);
			expect(wrapper.emitted('confirm-delete')).toBeUndefined();
		});

		it('cannot be dismissed while the delete runs', async () => {
			const wrapper = render({ deleteOpen: true, deleteName: 'Welcome', isDeleting: true });
			await wrapper.get('[data-testid="backdrop"]').trigger('click');
			expect(wrapper.emitted('cancel-delete')).toBeUndefined();
		});
	});
});
