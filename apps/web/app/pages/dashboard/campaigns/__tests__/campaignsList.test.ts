// @vitest-environment happy-dom
/**
 * The campaigns list runs on the shared list scaffold (`ListPageShell` +
 * `useListPage`). Mounted through a real vue-router, with the real shell,
 * segmented control and confirmation dialog, so the assertions are about what
 * a user and a screen reader get:
 *   - the status tabs expose the selected one (`aria-selected`), carry their
 *     counts, and keep `?status=` in step both ways;
 *   - the list reads through the organization-gated paginated query, and the
 *     selected tab reaches its server-side status filter;
 *   - delete goes through `UiConfirmationDialog`, not a hand-built modal;
 *   - an empty "Needs attention" is an all-clear with no create action, an
 *     empty browse tab offers "New campaign".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, useSlots } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import {
	createMemoryHistory,
	createRouter,
	RouterView,
	useRoute as routerUseRoute,
	useRouter as routerUseRouter,
} from 'vue-router';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ListPageShell from '~/components/list/ListPageShell.vue';
import ListSortMenu from '~/components/list/ListSortMenu.vue';
import UiQueryBoundary from '~/components/ui/QueryBoundary.vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiCard from '@owlat/ui/components/ui/Card.vue';
import UiConfirmationDialog from '@owlat/ui/components/ui/ConfirmationDialog.vue';
import UiEmptyState from '@owlat/ui/components/ui/EmptyState.vue';
import UiErrorAlert from '@owlat/ui/components/ui/ErrorAlert.vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import UiPageHeader from '@owlat/ui/components/ui/PageHeader.vue';
import UiSegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import UiSpinner from '@owlat/ui/components/ui/Spinner.vue';
import CampaignsIndex from '../index.vue';

const DRAFT = {
	_id: 'cmp_draft',
	name: 'Black Friday teaser',
	subject: 'Something is coming',
	status: 'draft',
	updatedAt: Date.parse('2026-09-20T09:00:00Z'),
};

const rows = ref<unknown[]>([]);
const removeCampaign = vi.fn(async (_args: unknown) => ({ ok: true, result: null }));
let listArgs: () => Record<string, unknown> | undefined = () => undefined;

// The modal chrome (teleport, focus trap) is not under test: render it inline.
const UiModalStub = defineComponent({
	props: { open: Boolean, persistent: Boolean, closable: Boolean },
	emits: ['update:open'],
	setup(props, { slots }) {
		return () =>
			props.open ? h('div', { role: 'dialog' }, [slots.default?.(), slots.footer?.()]) : null;
	},
});

// The row has its own suite; here it only needs to raise the page's row events.
const CommandRowStub = defineComponent({
	props: { row: { type: Object, required: true } },
	emits: ['open', 'runAction', 'abResults', 'duplicate', 'delete'],
	setup(props, { emit }) {
		return () =>
			h('li', { class: 'campaign-row' }, [
				(props.row as { campaign: { name: string } }).campaign.name,
				h('button', { class: 'row-delete', onClick: () => emit('delete') }, 'Delete'),
			]);
	},
});

const Blank = defineComponent({ render: () => h('span') });

function nameOf(fn: unknown) {
	return getFunctionName(fn as FunctionReference<'query'>);
}

beforeEach(() => {
	rows.value = [];
	removeCampaign.mockClear();
	listArgs = () => undefined;
	installNuxtStubs({
		...i18nStubs,
		useRoute: routerUseRoute,
		useRouter: routerUseRouter,
		useSlots,
		useDataTableViewport: () => ref(true),
		useOrganizationPaginatedQuery: (_query: unknown, args: () => Record<string, unknown>) => {
			listArgs = args;
			return { ...paginatedResult([]), results: rows };
		},
		// Reverting to the ungated query would reach this and fail the mount.
		usePaginatedQuery: () => {
			throw new Error('the campaigns list must read through useOrganizationPaginatedQuery');
		},
		useOrganizationQuery: (query: unknown) =>
			nameOf(query).endsWith('countByStatusByOrganization')
				? queryResult({ total: 3, draft: 2, scheduled: 0, sent: 1 })
				: queryResult([]),
		useBackendOperation: (op: unknown) => ({
			run: nameOf(op).endsWith(':remove') ? removeCampaign : vi.fn(),
			isLoading: ref(false),
			error: ref(null),
		}),
	});
});

async function mountList(url = '/dashboard/campaigns') {
	const router = createRouter({
		history: createMemoryHistory(),
		routes: [{ path: '/dashboard/campaigns', component: CampaignsIndex }],
	});
	await router.push(url);
	await router.isReady();
	const Host = defineComponent({ render: () => h(RouterView) });
	const wrapper = mount(Host, {
		global: {
			plugins: [router, createTestI18n()],
			components: {
				ListPageShell,
				ListSortMenu,
				UiQueryBoundary,
				UiButton,
				UiCard,
				UiConfirmationDialog,
				UiEmptyState,
				UiErrorAlert,
				UiInput,
				UiPageHeader,
				UiSegmentedControl,
				UiSpinner,
			},
			stubs: {
				UiModal: UiModalStub,
				CampaignsCommandRow: CommandRowStub,
				DashboardListSkeleton: Blank,
				Icon: Blank,
			},
		},
	});
	await flushPromises();
	return { wrapper, router };
}

const tab = (wrapper: Awaited<ReturnType<typeof mountList>>['wrapper'], label: RegExp) =>
	wrapper.findAll('[role="tab"]').find((t) => label.test(t.text()))!;

describe('campaigns list — status tabs', () => {
	it('exposes the selected tab to assistive technology, with the counts', async () => {
		const { wrapper } = await mountList();
		const tablist = wrapper.get('[role="tablist"]');
		expect(tablist.attributes('aria-label')).toBe('Campaign status');
		const tabs = tablist.findAll('[role="tab"]');
		expect(tabs.map((t) => t.text().replace(/\s+/g, ' '))).toEqual([
			'Needs attention 0',
			'All 3',
			'Drafts 2',
			'Scheduled 0',
			'Sent 1',
		]);
		expect(tabs.map((t) => t.attributes('aria-selected'))).toEqual([
			'true',
			'false',
			'false',
			'false',
			'false',
		]);
	});

	it('opens on the tab ?status= names', async () => {
		const { wrapper } = await mountList('/dashboard/campaigns?status=scheduled');
		expect(tab(wrapper, /^Scheduled/).attributes('aria-selected')).toBe('true');
		expect(listArgs()).toMatchObject({ status: 'scheduled' });
	});

	it('writes the chosen tab to ?status= and filters the list on the server', async () => {
		const { wrapper, router } = await mountList();
		await tab(wrapper, /^Drafts/).trigger('click');
		await flushPromises();
		expect(router.currentRoute.value.query['status']).toBe('draft');
		expect(tab(wrapper, /^Drafts/).attributes('aria-selected')).toBe('true');
		expect(listArgs()).toMatchObject({ status: 'draft' });

		await tab(wrapper, /^Needs attention/).trigger('click');
		await flushPromises();
		expect(router.currentRoute.value.query['status']).toBeUndefined();
	});
});

describe('campaigns list — empty states', () => {
	it('reads an empty "Needs attention" as all clear, with no create action', async () => {
		const { wrapper } = await mountList();
		const empty = wrapper.get('h2');
		expect(empty.text()).toBe('Nothing needs you.');
		expect(wrapper.text()).toContain('All clear');
		// The header's phone-only New campaign button is the only one.
		expect(wrapper.findAll('button').filter((b) => b.text() === 'New campaign')).toHaveLength(1);
	});

	it('offers New campaign on an empty browse tab', async () => {
		const { wrapper } = await mountList('/dashboard/campaigns?status=draft');
		expect(wrapper.get('h2').text()).toBe('No campaigns here yet');
		expect(wrapper.findAll('button').filter((b) => b.text() === 'New campaign')).toHaveLength(2);
	});
});

describe('campaigns list — delete', () => {
	it('confirms through UiConfirmationDialog and deletes on confirm', async () => {
		rows.value = [DRAFT];
		const { wrapper } = await mountList('/dashboard/campaigns?status=draft');
		expect(wrapper.find('.campaign-row').text()).toContain('Black Friday teaser');

		const dialog = wrapper.findComponent(UiConfirmationDialog);
		expect(dialog.exists()).toBe(true);
		expect(dialog.props('open')).toBe(false);

		await wrapper.get('.row-delete').trigger('click');
		expect(dialog.props('open')).toBe(true);
		expect(dialog.props('variant')).toBe('danger');
		const shown = wrapper.get('[role="dialog"]');
		expect(shown.text()).toContain('"Black Friday teaser"');

		const confirm = shown.findAll('button').find((b) => b.text() === 'Delete campaign');
		await confirm!.trigger('click');
		await flushPromises();
		expect(removeCampaign).toHaveBeenCalledWith({ campaignId: 'cmp_draft' });
		expect(dialog.props('open')).toBe(false);
	});
});
