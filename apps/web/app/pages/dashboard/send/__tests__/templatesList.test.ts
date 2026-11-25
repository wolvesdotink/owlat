/**
 * The templates page is the one list of every template: search, sort, the
 * grid/list switch and the row actions, a type filter only when there is a
 * transactional-typed template to separate, and exactly one create button.
 * Saved blocks and the media library are tabs beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import PageHeader from '@owlat/ui/components/ui/PageHeader.vue';
import SegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';

import SendIndex from '../index.vue';
import MarketingIndex from '../marketing/index.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import ListPageShell from '~/components/list/ListPageShell.vue';
import SendTabs from '~/components/send/SendTabs.vue';

const TEMPLATES = [
	{ _id: 't1', name: 'September newsletter', subject: 'Hello', type: 'marketing', updatedAt: 1 },
	{ _id: 't2', name: 'Password reset', subject: 'Reset', type: 'transactional', updatedAt: 2 },
];

let listArgs: unknown[];
let listArgsFactory: () => unknown;
let listOptions: Record<string, unknown>;
let push: ReturnType<typeof vi.fn>;
let replace: ReturnType<typeof vi.fn>;
let query: Record<string, string>;
let typeCounts: Record<string, number>;
let nameSortReady: boolean | undefined;
let listError: Error | null;
let refetchList: ReturnType<typeof vi.fn>;

beforeEach(() => {
	typeCounts = { total: 2, marketing: 1, transactional: 1 };
	nameSortReady = true;
	listArgs = [];
	push = vi.fn();
	replace = vi.fn();
	query = {};
	listError = null;
	refetchList = vi.fn();
});

// The shared template views have their own suites; here a row only needs its
// name, the page's `#meta` chips and a way to raise the row events.
const templateRows = {
	props: ['items'],
	emits: ['edit', 'duplicate', 'delete'],
	template: `<ul data-testid="template-list"><li v-for="item in items" :key="item._id">
		<button data-row="edit" @click="$emit('edit', item)">{{ item.name }}</button>
		<slot name="meta" :item="item" />
	</li></ul>`,
};

function render(templates = TEMPLATES, stubs: Record<string, unknown> = {}): VueWrapper {
	installNuxtStubs({
		...i18nStubs,
		...stubs,
		useRoute: () => ({ path: '/dashboard/send', query, params: {} }),
		useRouter: () => ({ push, replace }),
		useOrganizationQuery: (reference: FunctionReference<'query'>) => {
			const name = getFunctionName(reference);
			if (name === 'emailTemplates/organization:countByTypeByOrganization') {
				return queryResult(typeCounts);
			}
			if (name === 'emailBlocks/blocks:getStatsByTeam') return queryResult({ total: 4 });
			if (name === 'emailTemplates/emails:isNameSortReady') return queryResult(nameSortReady);
			return queryResult(undefined);
		},
		useOrganizationPaginatedQuery: (
			_reference: unknown,
			args: () => unknown,
			options: Record<string, unknown>
		) => {
			listArgs.push(args());
			listArgsFactory = args;
			listOptions = options;
			const result = paginatedResult(templates);
			result.error.value = listError as never;
			return { ...result, refetch: refetchList };
		},
	});
	return mount(SendIndex, {
		global: {
			plugins: [createTestI18n()],
			components: {
				ListPageShell,
				SendTabs,
				UiPageHeader: PageHeader,
				UiQueryBoundary: QueryBoundary,
				UiSegmentedControl: SegmentedControl,
			},
			stubs: {
				UiIconBox: true,
				UiErrorAlert: true,
				UiSpinner: true,
				UiInput: true,
				ListSortMenu: true,
				UiEmptyState: { props: ['title'], template: '<p data-stub="empty">{{ title }}</p>' },
				UiCard: { template: '<div><slot /></div>' },
				SendTemplateGrid: templateRows,
				SendTemplateTable: templateRows,
				SendTemplateCardList: templateRows,
				SendTemplateStatusBadge: true,
				LazyMailTemplateLibraryModal: true,
				UiButton: {
					emits: ['click'],
					template: '<button data-stub="button" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	}) as VueWrapper;
}

describe('templates list', () => {
	it('lists every template with its type and one create button', async () => {
		const wrapper = render();
		const rows = wrapper.findAll('[data-testid="template-list"] li');
		expect(rows).toHaveLength(2);
		const row = (name: string) => rows.find((r) => r.text().includes(name))!;
		expect(row('Password reset').text()).toContain('Transactional');
		// Marketing is the default, so only the transactional row carries a badge.
		expect(row('September newsletter').text()).not.toContain('Marketing');
		await row('Password reset').get('[data-row="edit"]').trigger('click');
		expect(push).toHaveBeenCalledWith('/dashboard/send/emails/t2/edit');
		expect(wrapper.findAll('[data-testid="new-template"]')).toHaveLength(1);
		expect(wrapper.text()).not.toContain('Quick actions');
	});

	it('offers a type filter with counts', () => {
		const wrapper = render();
		const filter = wrapper.find('[data-testid="template-type-filter"]');
		expect(filter.findAll('[role="tab"]').map((b) => b.text().replace(/\s+/g, ' '))).toEqual([
			'All 2',
			'Marketing 1',
			'Transactional 1',
		]);
	});

	it('sits beside saved blocks and the media library, with their counts', () => {
		const tabs = render().get('nav').findAll('a');
		expect(tabs.map((a) => a.attributes('href'))).toEqual([
			'/dashboard/send',
			'/dashboard/send/blocks',
			'/dashboard/send/media',
		]);
		expect(tabs.map((a) => a.text().replace(/\s+/g, ' '))).toEqual([
			'Templates 2',
			'Saved blocks 4',
			'Media library',
		]);
		expect(tabs.map((a) => a.attributes('aria-current'))).toEqual(['page', undefined, undefined]);
	});

	it('exposes the filter as a named tablist with the selected type (#865)', () => {
		query = { type: 'transactional' };
		const wrapper = render();
		const tablist = wrapper.get('[data-testid="template-type-filter"] [role="tablist"]');
		expect(tablist.attributes('aria-label')).toBe('Template type');
		const tabs = tablist.findAll('[role="tab"]');
		expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['false', 'false', 'true']);
		// Roving tabindex: only the selected tab is in the tab order.
		expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['-1', '-1', '0']);
	});

	it('queries all types by default and one type when filtered', () => {
		render();
		expect(listArgs.at(-1)).toEqual({ sortBy: 'updatedAt', sortOrder: 'desc' });
		query = { type: 'transactional' };
		render();
		expect(listArgs.at(-1)).toEqual({
			type: 'transactional',
			sortBy: 'updatedAt',
			sortOrder: 'desc',
		});
	});

	describe('sort', () => {
		const names = (wrapper: VueWrapper) =>
			wrapper.findAll('[data-testid="template-list"] [data-row="edit"]').map((row) => row.text());
		const sortMenu = (wrapper: VueWrapper) => wrapper.findComponent({ name: 'ListSortMenu' });

		afterEach(() => {
			vi.useRealTimers();
		});

		it('runs on the server and starts over from the first page when it changes', async () => {
			// The server's order, which is not the order a name sort in the browser
			// would give: the page must show it as it is.
			const wrapper = render([TEMPLATES[1]!, TEMPLATES[0]!]);
			expect(listArgsFactory()).toEqual({ sortBy: 'updatedAt', sortOrder: 'desc' });

			sortMenu(wrapper).vm.$emit('update:modelValue', 'name-desc');
			await nextTick();

			// New args reopen the subscription from the first page, and without
			// `keepPreviousData` nothing of the old order stays on screen meanwhile.
			expect(listArgsFactory()).toEqual({ sortBy: 'name', sortOrder: 'desc' });
			expect(listOptions['keepPreviousData']).toBeFalsy();
			expect(names(wrapper)).toEqual(['Password reset', 'September newsletter']);
		});

		it('is disabled during a search, which is ordered by relevance', async () => {
			vi.useFakeTimers();
			const wrapper = render();
			expect(sortMenu(wrapper).attributes('disabled-label')).toBeUndefined();

			wrapper.findComponent({ name: 'UiInput' }).vm.$emit('update:modelValue', 'reset');
			await vi.advanceTimersByTimeAsync(300);
			await nextTick();

			expect(listArgsFactory()).toEqual({ search: 'reset' });
			expect(sortMenu(wrapper).attributes('disabled-label')).toBe('Sorted by relevance');
		});

		it('offers the name sorts only once every template has its sort key', async () => {
			nameSortReady = false;
			const wrapper = render();
			const offered = () =>
				(wrapper.findComponent(ListPageShell).props('sortOptions') as { value: string }[]).map(
					(option) => option.value
				);
			expect(offered()).not.toContain('name-asc');

			// A name sort picked anyway is served, and shown, as the default.
			sortMenu(wrapper).vm.$emit('update:modelValue', 'name-asc');
			await nextTick();
			expect(listArgsFactory()).toEqual({ sortBy: 'updatedAt', sortOrder: 'desc' });
			expect(wrapper.findComponent(ListPageShell).props('sort')).toBe('updatedAt-desc');
		});

		it('stays on for a blank search, which the server treats as none', async () => {
			vi.useFakeTimers();
			const wrapper = render();

			wrapper.findComponent({ name: 'UiInput' }).vm.$emit('update:modelValue', '   ');
			await vi.advanceTimersByTimeAsync(300);
			await nextTick();

			expect(listArgsFactory()).toEqual({ sortBy: 'updatedAt', sortOrder: 'desc' });
			expect(sortMenu(wrapper).attributes('disabled-label')).toBeUndefined();
		});
	});

	it('writes the chosen filter into the URL', async () => {
		const wrapper = render();
		const marketing = wrapper
			.find('[data-testid="template-type-filter"]')
			.findAll('[role="tab"]')
			.find((b) => b.text().startsWith('Marketing'));
		await marketing!.trigger('click');
		expect(replace).toHaveBeenCalledWith({ query: { type: 'marketing' } });
	});

	it('clears the type from the URL when the arrow keys reach All', async () => {
		query = { type: 'marketing' };
		const wrapper = render();
		await wrapper
			.get('[data-testid="template-type-filter"] [role="tablist"]')
			.trigger('keydown', { key: 'ArrowLeft' });
		expect(replace).toHaveBeenCalledWith({ query: { type: undefined } });
	});

	it('names the filter in the empty state', () => {
		query = { type: 'marketing' };
		const wrapper = render([]);
		expect(wrapper.find('[data-stub="empty"]').text()).toBe('No marketing templates yet');
	});

	describe('the pointer to transactional emails', () => {
		const HINT = '[data-testid="template-transactional-hint"]';
		const permissions = (isAdmin: boolean) => ({
			usePermissions: () => ({
				can: () => isAdmin,
				showGateFor: () => false,
				isAdmin: ref(isAdmin),
			}),
		});
		const flags = (on: boolean) => ({ useFeatureFlag: () => ({ isEnabled: () => on }) });

		it('shows under the Transactional filter and links to the list', () => {
			query = { type: 'transactional' };
			const hint = render(TEMPLATES, { ...permissions(true), ...flags(true) }).get(HINT);
			expect(hint.get('a').attributes('href')).toBe('/dashboard/send/transactional');
		});

		it('stays away from the other filters', () => {
			expect(
				render(TEMPLATES, { ...permissions(true), ...flags(true) })
					.find(HINT)
					.exists()
			).toBe(false);
			query = { type: 'marketing' };
			expect(
				render(TEMPLATES, { ...permissions(true), ...flags(true) })
					.find(HINT)
					.exists()
			).toBe(false);
		});

		it('is not shown to a member who cannot open transactional emails', () => {
			query = { type: 'transactional' };
			expect(
				render(TEMPLATES, { ...permissions(false), ...flags(true) })
					.find(HINT)
					.exists()
			).toBe(false);
		});

		it('is not shown while the transactional feature is off', () => {
			query = { type: 'transactional' };
			expect(
				render(TEMPLATES, { ...permissions(true), ...flags(false) })
					.find(HINT)
					.exists()
			).toBe(false);
		});
	});

	describe('with no transactional-typed template', () => {
		beforeEach(() => {
			typeCounts = { total: 1, marketing: 1, transactional: 0 };
		});

		it('hides the type filter, since it would separate nothing', () => {
			expect(render([TEMPLATES[0]!]).find('[data-testid="template-type-filter"]').exists()).toBe(
				false
			);
		});

		it('lists every template even when a stale link asks for one type', () => {
			query = { type: 'transactional' };
			render([TEMPLATES[0]!]);
			expect(listArgs.at(-1)).not.toHaveProperty('type');
		});

		it('leaves out the transactional hint', () => {
			query = { type: 'transactional' };
			const wrapper = render([TEMPLATES[0]!], {
				usePermissions: () => ({ can: () => true, showGateFor: () => false, isAdmin: ref(true) }),
				useFeatureFlag: () => ({ isEnabled: () => true }),
			});
			expect(wrapper.find('[data-testid="template-transactional-hint"]').exists()).toBe(false);
		});
	});

	it('shows a failed read with Try again instead of an empty list (#721)', async () => {
		listError = new Error('[CONVEX Q(emailTemplates/emails:list)] [Request ID: 1] Server Error');
		const wrapper = render([]);

		expect(wrapper.find('[data-stub="empty"]').exists()).toBe(false);
		const retry = wrapper.findAll('[data-stub="button"]').find((b) => b.text() === 'Try again');
		expect(retry).toBeDefined();
		await retry!.trigger('click');
		expect(refetchList).toHaveBeenCalledTimes(1);
	});
});

describe('the retired marketing templates route', () => {
	it('redirects to the one templates list, keeping the query and hash', () => {
		const definePageMeta = vi.fn();
		vi.stubGlobal('definePageMeta', definePageMeta);
		mount(MarketingIndex);
		const meta = definePageMeta.mock.calls[0]?.[0] as {
			redirect: (to: { query: Record<string, string>; hash: string }) => unknown;
		};
		expect(meta.redirect({ query: { q: 'autumn' }, hash: '#x' })).toEqual({
			path: '/dashboard/send',
			query: { q: 'autumn' },
			hash: '#x',
		});
	});
});
