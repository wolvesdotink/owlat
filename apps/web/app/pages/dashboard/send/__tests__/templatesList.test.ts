// @vitest-environment happy-dom
/**
 * The templates page is one list with a type filter (#787): no stat tiles, no
 * Quick Actions row (with Media and Files), and exactly one create button.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { getFunctionName, type FunctionReference } from 'convex/server';
import SegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import PageHeader from '@owlat/ui/components/ui/PageHeader.vue';

import SendIndex from '../index.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';

const TEMPLATES = [
	{ _id: 't1', name: 'September newsletter', subject: 'Hello', type: 'marketing', updatedAt: 1 },
	{ _id: 't2', name: 'Password reset', subject: 'Reset', type: 'transactional', updatedAt: 2 },
];

let listArgs: unknown[];
let replace: ReturnType<typeof vi.fn>;
let query: Record<string, string>;

beforeEach(() => {
	listArgs = [];
	replace = vi.fn();
	query = {};
});

function render(templates = TEMPLATES): VueWrapper {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ path: '/dashboard/send', query, params: {} }),
		useRouter: () => ({ push: vi.fn(), replace }),
		useOrganizationQuery: (reference: FunctionReference<'query'>) => {
			const name = getFunctionName(reference);
			if (name === 'emailTemplates/organization:countByTypeByOrganization') {
				return queryResult({ total: 2, marketing: 1, transactional: 1 });
			}
			if (name === 'emailBlocks/blocks:getStatsByTeam') return queryResult({ total: 4 });
			return queryResult(undefined);
		},
		usePaginatedQuery: (_reference: unknown, args: () => unknown) => {
			listArgs.push(args());
			return paginatedResult(templates);
		},
	});
	return mount(SendIndex, {
		global: {
			plugins: [createTestI18n()],
			components: {
				UiSegmentedControl: SegmentedControl,
				UiPageHeader: PageHeader,
				UiQueryBoundary: QueryBoundary,
			},
			stubs: {
				UiIconBox: true,
				UiErrorAlert: true,
				UiSpinner: true,
				UiEmptyState: { props: ['title'], template: '<p data-stub="empty">{{ title }}</p>' },
				UiCard: { template: '<div><slot /></div>' },
				LazyMailTemplateLibraryModal: true,
				DashboardListSkeleton: true,
			},
		},
	}) as VueWrapper;
}

describe('templates list', () => {
	it('lists every template with its type and one create button', () => {
		const wrapper = render();
		const rows = wrapper.findAll('[data-testid="template-list"] li');
		expect(rows.map((r) => r.find('a').attributes('href'))).toEqual([
			'/dashboard/send/emails/t1/edit',
			'/dashboard/send/emails/t2/edit',
		]);
		expect(rows[1]!.text()).toContain('Transactional');
		expect(wrapper.findAll('[data-testid="new-template"]')).toHaveLength(1);
		expect(wrapper.text()).not.toContain('Quick actions');
		expect(wrapper.text()).not.toContain('Media');
	});

	it('offers a type filter with counts and links saved blocks', () => {
		const wrapper = render();
		const filter = wrapper.find('[data-testid="template-type-filter"]');
		expect(filter.findAll('button').map((b) => b.text())).toEqual([
			'All (2)',
			'Marketing (1)',
			'Transactional (1)',
		]);
		expect(wrapper.text()).toContain('Saved blocks (4)');
	});

	it('queries all types by default and one type when filtered', () => {
		render();
		expect(listArgs.at(-1)).toEqual({});
		query = { type: 'transactional' };
		render();
		expect(listArgs.at(-1)).toEqual({ type: 'transactional' });
	});

	it('writes the chosen filter into the URL', async () => {
		const wrapper = render();
		const marketing = wrapper
			.find('[data-testid="template-type-filter"]')
			.findAll('button')
			.find((b) => b.text().startsWith('Marketing'));
		await marketing!.trigger('click');
		expect(replace).toHaveBeenCalledWith({ query: { type: 'marketing' } });
	});

	it('names the filter in the empty state', () => {
		query = { type: 'marketing' };
		const wrapper = render([]);
		expect(wrapper.find('[data-stub="empty"]').text()).toBe('No marketing templates yet');
	});
});
