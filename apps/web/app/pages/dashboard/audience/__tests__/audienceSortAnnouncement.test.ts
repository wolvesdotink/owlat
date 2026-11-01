/**
 * The Topics and Segments lists and the member table on a topic's and a
 * segment's detail page announce their sort. With the chevron as the only
 * cue, a screen reader could not tell which column was sorted or in which
 * direction.
 *
 * Each page is mounted with the REAL sort state (`useDataTable`, through
 * `useMemberTable` on the detail pages) and the real table components, over
 * rows whose order differs per column. After the default render and after each
 * header click, exactly one header carries `aria-sort`, it is the header of the
 * column the rows are actually ordered by, and its value matches the direction
 * the rows are in. Unlike the contacts list, these tables keep sorting
 * client-side while a search is active, so there is no relevance carve-out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Component } from 'vue';

import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { NuxtLinkStub } from '~/__tests__/nuxtComponents';
import { paginatedResult, queryResult } from '~/__tests__/queryStubs';
import AudienceListTable from '~/components/audience/AudienceListTable.vue';
import MemberTable from '~/components/audience/MemberTable.vue';
import ListPageShell from '~/components/list/ListPageShell.vue';
import { useBreadcrumbs } from '~/composables/useBreadcrumbs';
import { useDataTable } from '~/composables/useDataTable';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useLoadAllPages } from '~/composables/useLoadAllPages';
import { useMemberTable } from '~/composables/useMemberTable';
import { formatDate } from '~/utils/formatters';

// Name, count and creation order all disagree, so every column sorts differently.
const TOPICS = [
	{ _id: 'tp_a', name: 'Alpha', description: '', contactCount: 30, createdAt: 2 },
	{ _id: 'tp_b', name: 'Bravo', description: '', contactCount: 10, createdAt: 3 },
	{ _id: 'tp_c', name: 'Charlie', description: '', contactCount: 20, createdAt: 1 },
];
const SEGMENTS = TOPICS.map(({ _id, contactCount, ...rest }) => ({
	...rest,
	_id: _id.replace('tp', 'sg'),
	cachedCount: contactCount,
	filters: { logic: 'AND', conditions: [] },
}));

// Email, first name, last name and date order all disagree too.
const MEMBERS = [
	{ _id: 'c_1', email: 'ada@example.com', firstName: 'Zoe', lastName: 'Moss', at: 2 },
	{ _id: 'c_2', email: 'bea@example.com', firstName: 'Mia', lastName: 'Ames', at: 3 },
	{ _id: 'c_3', email: 'cy@example.com', firstName: 'Ann', lastName: 'Zorn', at: 1 },
];
const topicMembers = MEMBERS.map(({ at, ...row }) => ({ ...row, addedAt: at }));
const segmentMembers = MEMBERS.map(({ at, ...row }) => ({ ...row, createdAt: at }));

const noop = () => vi.fn();
const formStub = (prefix: 'topic' | 'segment') => ({
	[`is${prefix === 'topic' ? 'Topic' : 'Segment'}ModalOpen`]: ref(false),
	isEditMode: ref(false),
	[`${prefix}Form`]: {
		name: '',
		description: '',
		requireDoubleOptIn: false,
		filters: { logic: 'AND', conditions: [] },
	},
	[`${prefix}Errors`]: { name: '', conditions: '', general: '' },
	isSaving: ref(false),
	isSegmentFormDirty: ref(false),
	matchingCount: ref(null),
	countLoading: ref(false),
	openCreateModal: noop(),
	openEditModal: noop(),
	[`close${prefix === 'topic' ? 'Topic' : 'Segment'}Modal`]: noop(),
	handleSave: noop(),
	isDeleteModalOpen: ref(false),
	deleteTarget: ref(null),
	isDeleting: ref(false),
	openDeleteModal: noop(),
	closeDeleteModal: noop(),
	handleDelete: noop(),
});

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		useBreadcrumbs,
		useDataTable,
		useDebouncedSearch,
		useLoadAllPages,
		useMemberTable,
		formatDate,
		useRouteId: () => ref('id1'),
		useTopicsList: () => paginatedResult([]),
		useSegmentFilters: () => ({
			describeFilters: () => 'All contacts',
			addCondition: vi.fn(),
			removeCondition: vi.fn(),
		}),
		useTopicForm: () => formStub('topic'),
		useSegmentForm: () => formStub('segment'),
		useFormModal: () => ({
			isOpen: ref(false),
			open: vi.fn(),
			close: vi.fn(),
			requestClose: vi.fn(),
			isConfirmOpen: ref(false),
			confirmDiscard: vi.fn(),
			cancelDiscard: vi.fn(),
		}),
	});
});

interface PageCase {
	name: string;
	load: () => Promise<{ default: Component }>;
	stubs: () => Record<string, unknown>;
	/** The default sort: header label, direction, row order. */
	initial: Step;
	/** Header clicks, each with the state it must leave behind. */
	clicks: Step[];
}

interface Step {
	header: string;
	direction: 'ascending' | 'descending';
	rows: string[];
}

const listStubs = (rows: unknown[]) => () => ({
	useOrganizationPaginatedQuery: () => paginatedResult(rows),
});

const detailStubs = (doc: unknown, rows: unknown[]) => () => ({
	useConvexQuery: () => queryResult(doc),
	usePaginatedQuery: () => paginatedResult(rows),
});

const PAGES: PageCase[] = [
	{
		name: 'topics list',
		load: () => import('../topics/index.vue'),
		stubs: listStubs(TOPICS),
		initial: { header: 'Created', direction: 'descending', rows: ['Bravo', 'Alpha', 'Charlie'] },
		clicks: [
			{ header: 'Created', direction: 'ascending', rows: ['Charlie', 'Alpha', 'Bravo'] },
			{ header: 'Name', direction: 'ascending', rows: ['Alpha', 'Bravo', 'Charlie'] },
			{ header: 'Name', direction: 'descending', rows: ['Charlie', 'Bravo', 'Alpha'] },
			{ header: 'Contacts', direction: 'ascending', rows: ['Bravo', 'Charlie', 'Alpha'] },
		],
	},
	{
		name: 'segments list',
		load: () => import('../segments/index.vue'),
		stubs: listStubs(SEGMENTS),
		initial: { header: 'Created', direction: 'descending', rows: ['Bravo', 'Alpha', 'Charlie'] },
		clicks: [
			{ header: 'Created', direction: 'ascending', rows: ['Charlie', 'Alpha', 'Bravo'] },
			{ header: 'Name', direction: 'ascending', rows: ['Alpha', 'Bravo', 'Charlie'] },
			{ header: 'Name', direction: 'descending', rows: ['Charlie', 'Bravo', 'Alpha'] },
			{ header: 'Contacts', direction: 'ascending', rows: ['Bravo', 'Charlie', 'Alpha'] },
		],
	},
	{
		name: 'topic members',
		load: () => import('../topics/[id]/index.vue'),
		stubs: detailStubs(
			{ _id: 'id1', name: 'Product updates', contactCount: 3, createdAt: 0 },
			topicMembers
		),
		initial: {
			header: 'Added',
			direction: 'descending',
			rows: ['bea@example.com', 'ada@example.com', 'cy@example.com'],
		},
		clicks: [
			{
				header: 'Added',
				direction: 'ascending',
				rows: ['cy@example.com', 'ada@example.com', 'bea@example.com'],
			},
			{
				header: 'First name',
				direction: 'ascending',
				rows: ['cy@example.com', 'bea@example.com', 'ada@example.com'],
			},
			{
				header: 'Last name',
				direction: 'ascending',
				rows: ['bea@example.com', 'ada@example.com', 'cy@example.com'],
			},
			{
				header: 'Last name',
				direction: 'descending',
				rows: ['cy@example.com', 'ada@example.com', 'bea@example.com'],
			},
		],
	},
	{
		name: 'segment members',
		load: () => import('../segments/[id]/index.vue'),
		stubs: detailStubs(
			{ _id: 'id1', name: 'Engaged', cachedCount: 3, createdAt: 0, filters: {} },
			segmentMembers
		),
		initial: {
			header: 'Email',
			direction: 'ascending',
			rows: ['ada@example.com', 'bea@example.com', 'cy@example.com'],
		},
		clicks: [
			{
				header: 'Email',
				direction: 'descending',
				rows: ['cy@example.com', 'bea@example.com', 'ada@example.com'],
			},
			{
				header: 'Added',
				direction: 'descending',
				rows: ['bea@example.com', 'ada@example.com', 'cy@example.com'],
			},
			{
				header: 'First name',
				direction: 'ascending',
				rows: ['cy@example.com', 'bea@example.com', 'ada@example.com'],
			},
		],
	},
];

type Wrapper = ReturnType<typeof mountDashboardPage>;

function expectSortAnnounced(wrapper: Wrapper, step: Step) {
	const sorted = wrapper.findAll('thead th').filter((th) => th.attributes('aria-sort'));
	expect(sorted.map((th) => [th.text(), th.attributes('aria-sort')])).toEqual([
		[step.header, step.direction],
	]);
	// The announced header is the one whose button drives the sort.
	expect(sorted[0]!.find('button').exists()).toBe(true);
	// ...and the rows really are in that order.
	const rows = wrapper.findAll('tbody tr').map((tr) => tr.find('td a').text());
	expect(rows).toEqual(step.rows);
}

describe('audience tables announce their sort (#1433)', () => {
	it.each(PAGES)('$name marks exactly the sorted header', async (page) => {
		installNuxtStubs(page.stubs());
		const { default: Page } = await page.load();
		const wrapper = mountDashboardPage(Page, {
			components: { ListPageShell, AudienceListTable, AudienceMemberTable: MemberTable },
			stubs: {
				NuxtLink: NuxtLinkStub,
				AudienceTabs: true,
				DashboardListSkeleton: true,
				DashboardDetailSkeleton: true,
				UiPageHeader: true,
				UiModal: true,
				UiConfirmationDialog: true,
				UnsavedChangesDialog: true,
				UiInput: true,
				UiTextarea: true,
				UiCheckbox: true,
				UiButton: true,
				ListSortMenu: true,
				UiSegmentedControl: true,
				ConditionsConditionEditor: true,
				// Passes its content through: the list pages render inside it.
				UiQueryBoundary: { template: '<div><slot /></div>' },
			},
		});

		expectSortAnnounced(wrapper, page.initial);
		// Non-sortable headers (Actions, a segment's Filters) exist and stay silent.
		expect(wrapper.findAll('thead th').length).toBeGreaterThan(3);

		for (const step of page.clicks) {
			const button = wrapper
				.findAll('thead th button')
				.find((candidate) => candidate.text() === step.header);
			expect(button, step.header).toBeDefined();
			await button!.trigger('click');
			expectSortAnnounced(wrapper, step);
		}
		wrapper.unmount();
	});
});
