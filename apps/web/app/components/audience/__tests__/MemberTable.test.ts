// @vitest-environment happy-dom
/**
 * `MemberTable` is the contact table both audience detail pages render
 * (segments and topics). Mounted with the real UI layer so the assertions are
 * about what a user gets:
 *   - every row's email is a link, so the table has a keyboard route (the
 *     rows used to be mouse-only `<tr @click>`), and a click elsewhere on a
 *     row still opens the contact, but a click on a row action does not;
 *   - the header sorts only declared columns and shows the active chevron;
 *   - below `md` exactly one of the table and the card list is mounted;
 *   - the empty, no-results and paging states, and a failed read (#721).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref, useSlots, type Component } from 'vue';

import MemberTable from '../MemberTable.vue';
import UiEmptyState from '@owlat/ui/components/ui/EmptyState.vue';
import UiCard from '@owlat/ui/components/ui/Card.vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import UiErrorAlert from '@owlat/ui/components/ui/ErrorAlert.vue';
import UiSpinner from '@owlat/ui/components/ui/Spinner.vue';
import UiQueryBoundary from '~/components/ui/QueryBoundary.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const tableFits = ref(true);
const push = vi.fn();

beforeEach(() => {
	tableFits.value = true;
	push.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useSlots', useSlots);
	vi.stubGlobal('useRouter', () => ({ push }));
	vi.stubGlobal('useDataTableViewport', () => tableFits);
});

const rows = [
	{ _id: 'c_1', email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', addedAt: 1 },
	{ _id: 'c_2', email: 'grace@example.com', addedAt: 2 },
];

const baseProps = {
	rows,
	dateField: 'addedAt',
	rowTo: (row: { _id: string }) => `/dashboard/audience/contacts/${row._id}`,
	search: '',
	activeSearch: '',
	searchPlaceholder: 'Search contacts in this topic...',
	loading: false,
	error: null as Error | null,
	empty: { icon: 'lucide:users', title: 'No contacts in this topic', description: 'Add some.' },
	isSortable: (field: string) => ['email', 'firstName', 'lastName', 'addedAt'].includes(field),
	getSortIcon: (field: string) => (field === 'addedAt' ? 'lucide:chevron-down' : null),
	currentPage: 1,
	totalPages: 3,
	pageNumbers: [1, 2, 3] as (number | '...')[],
	showingRange: { start: 1, end: 25, total: 60 } as {
		start: number;
		end: number;
		total: number;
	} | null,
};

function render(props: Partial<typeof baseProps> = {}, slots: Record<string, string> = {}) {
	// A generic SFC: mounted through `Component` so the props object is not
	// checked against the inferred row type.
	return mount(MemberTable as Component, {
		props: { ...baseProps, ...props },
		slots,
		global: {
			plugins: [createTestI18n()],
			components: { UiEmptyState, UiCard, UiInput, UiErrorAlert, UiSpinner, UiQueryBoundary },
		},
	});
}

describe('MemberTable rows', () => {
	it('links every email to the contact', () => {
		const links = render().findAll('tbody a');
		expect(links.map((link) => link.attributes('href'))).toEqual([
			'/dashboard/audience/contacts/c_1',
			'/dashboard/audience/contacts/c_2',
		]);
		expect(links[0]!.classes()).toContain('focus-visible:ring-2');
	});

	it('opens the contact on a click elsewhere in the row', async () => {
		const wrapper = render();
		await wrapper.findAll('tbody tr')[1]!.find('td:nth-child(2)').trigger('click');
		expect(push).toHaveBeenCalledWith('/dashboard/audience/contacts/c_2');
	});

	it('leaves a row action to itself', async () => {
		const wrapper = render(
			{},
			{ 'row-actions': '<button type="button" class="remove">Remove</button>' }
		);
		expect(wrapper.findAll('thead th').at(-1)!.text()).toBe('Actions');
		await wrapper.get('tbody button.remove').trigger('click');
		expect(push).not.toHaveBeenCalled();
	});

	it('has no actions column without row actions', () => {
		expect(render().findAll('thead th')).toHaveLength(4);
	});

	it('shows a dash for a missing name and the full name on the card', () => {
		const wrapper = render();
		expect(wrapper.findAll('tbody tr')[1]!.text()).toContain('—');
		tableFits.value = false;
		const cards = render();
		expect(cards.find('table').exists()).toBe(false);
		expect(cards.findAll('li')).toHaveLength(2);
		expect(cards.get('li a').attributes('href')).toBe('/dashboard/audience/contacts/c_1');
		expect(cards.get('li').text()).toContain('Ada Lovelace');
	});
});

describe('MemberTable header', () => {
	it('sorts through a button per column and marks the active one', async () => {
		const wrapper = render();
		const headers = wrapper.findAll('thead th button');
		expect(headers.map((header) => header.text())).toEqual([
			'Email',
			'First name',
			'Last name',
			'Added',
		]);
		expect(headers[3]!.find('[aria-hidden="true"]').exists()).toBe(true);
		expect(headers[0]!.find('[aria-hidden="true"]').exists()).toBe(false);

		await headers[1]!.trigger('click');
		expect(wrapper.emitted('sort')).toEqual([['firstName']]);
	});

	it('renders an undeclared column as plain text', () => {
		const wrapper = render({ isSortable: (field: string) => field !== 'lastName' });
		expect(wrapper.findAll('thead th button')).toHaveLength(3);
		expect(wrapper.findAll('thead th')[2]!.text()).toBe('Last name');
	});
});

describe('MemberTable states', () => {
	it('shows the empty state with the page action when nothing is there', () => {
		const wrapper = render(
			{ rows: [], showingRange: null },
			{ 'empty-action': '<a href="/dashboard/audience/contacts">Browse contacts</a>' }
		);
		expect(wrapper.get('h2').text()).toBe('No contacts in this topic');
		expect(wrapper.text()).toContain('Browse contacts');
		expect(wrapper.find('table').exists()).toBe(false);
	});

	it('offers to clear a search that matched nothing', async () => {
		const wrapper = render({ rows: [], showingRange: null, search: 'zz', activeSearch: 'zz' });
		expect(wrapper.get('h2').text()).toBe('No results found');
		expect(wrapper.text()).toContain('No contacts match "zz"');
		const clear = wrapper.findAll('button').find((button) => button.text() === 'Clear search');
		await clear!.trigger('click');
		expect(wrapper.emitted('clear-search')).toHaveLength(1);
	});

	it('shows a failed member read with Try again, not "no contacts" (#721)', async () => {
		const wrapper = render({
			rows: [],
			showingRange: null,
			error: new Error('[CONVEX Q(segments:listMembers)] [Request ID: 1] Server Error'),
		});
		expect(wrapper.text()).not.toContain('No contacts in this topic');
		expect(wrapper.text()).toContain('Failed to load');
		expect(wrapper.text()).not.toContain('Request ID');
		const retry = wrapper.findAll('button').find((button) => button.text() === 'Try again');
		await retry!.trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);
	});

	it('shows no empty state while the first page loads', () => {
		const wrapper = render({ rows: [], showingRange: null, loading: true });
		expect(wrapper.find('h2').exists()).toBe(false);
	});

	it('forwards the search input', async () => {
		const wrapper = render();
		await wrapper.get('input').setValue('ada');
		expect(wrapper.emitted('update:search')).toEqual([['ada']]);
	});
});

describe('MemberTable paging', () => {
	it('shows the range and moves between pages', async () => {
		const wrapper = render();
		expect(wrapper.text()).toContain('Showing 1-25 of 60');

		const previous = wrapper.get('button[aria-label="Previous"]');
		expect(previous.attributes('disabled')).toBeDefined();
		expect(wrapper.get('button[aria-current="page"]').text()).toBe('1');

		await wrapper.get('button[aria-label="Next"]').trigger('click');
		const pageThree = wrapper.findAll('nav button').find((button) => button.text() === '3');
		await pageThree!.trigger('click');
		expect(wrapper.emitted('page')).toEqual([[2], [3]]);
	});

	it('disables Next on the last page', () => {
		const wrapper = render({ currentPage: 3 });
		expect(wrapper.get('button[aria-label="Next"]').attributes('disabled')).toBeDefined();
	});
});
