// @vitest-environment happy-dom
/**
 * The automations list runs on the shared list scaffold (`ListPageShell` +
 * `useListPage`). Mounted with the real shell, segmented control, confirmation
 * dialog, rows and row actions, so the assertions are about what a user and a
 * screen reader get:
 *   - the status tabs expose the selected one (`aria-selected`), carry their
 *     counts, and the selected tab reaches the server-side status filter;
 *   - the list reads through the organization-gated paginated query;
 *   - below `md` the rows are a card list whose names are links;
 *   - delete goes through `UiConfirmationDialog`, and an automation that turned
 *     active while the dialog was open is refused: confirm is disabled and the
 *     dialog says why.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, useSlots } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useAutomationBadges } from '~/composables/useAutomationBadges';
import ListPageShell from '~/components/list/ListPageShell.vue';
import ListSortMenu from '~/components/list/ListSortMenu.vue';
import AutomationsListTable from '~/components/automations/ListTable.vue';
import AutomationsRowActions from '~/components/automations/RowActions.vue';
import UiQueryBoundary from '~/components/ui/QueryBoundary.vue';
import UiCard from '@owlat/ui/components/ui/Card.vue';
import UiConfirmationDialog from '@owlat/ui/components/ui/ConfirmationDialog.vue';
import UiEmptyState from '@owlat/ui/components/ui/EmptyState.vue';
import UiErrorAlert from '@owlat/ui/components/ui/ErrorAlert.vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import UiPageHeader from '@owlat/ui/components/ui/PageHeader.vue';
import UiSegmentedControl from '@owlat/ui/components/ui/SegmentedControl.vue';
import UiSpinner from '@owlat/ui/components/ui/Spinner.vue';
import AutomationsIndex from '../index.vue';

const created = Date.parse('2026-03-02T09:00:00Z');
const WELCOME = {
	_id: 'au_welcome',
	name: 'Welcome sequence',
	status: 'active',
	triggerType: 'contact_created',
	statsActive: 318,
	createdAt: created,
};
const REENGAGE = {
	_id: 'au_reengage',
	name: 'Re-engagement: 90 days quiet',
	status: 'paused',
	triggerType: 'event_received',
	statsActive: 0,
	createdAt: created,
};
const DRAFT = {
	_id: 'au_draft',
	name: 'Birthday greeting',
	status: 'draft',
	triggerType: 'contact_updated',
	createdAt: created,
};

const rows = ref<Record<string, unknown>[]>([]);
const tableFits = ref(true);
const removeAutomation = vi.fn(async (_args: unknown) => ({ ok: true, result: null }));
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

// The menu's positioning and teleport are the primitive's own suite; here its
// items render in place so a row's actions can be clicked.
const UiDropdownMenuStub = defineComponent({
	setup(_props, { slots }) {
		return () => h('div', { class: 'menu' }, [slots['trigger']?.(), slots.default?.()]);
	},
});
const UiDropdownMenuItemStub = defineComponent({
	props: { icon: String, disabled: Boolean, danger: Boolean },
	emits: ['click'],
	setup(props, { slots, emit }) {
		return () =>
			h(
				'button',
				{
					role: 'menuitem',
					disabled: props.disabled,
					onClick: (e: MouseEvent) => emit('click', e),
				},
				slots.default?.()
			);
	},
});

const Blank = defineComponent({ render: () => h('span') });

function nameOf(fn: unknown) {
	return getFunctionName(fn as FunctionReference<'query'>);
}

beforeEach(() => {
	rows.value = [WELCOME, REENGAGE, DRAFT];
	tableFits.value = true;
	removeAutomation.mockClear();
	listArgs = () => undefined;
	installNuxtStubs({
		...i18nStubs,
		useSlots,
		useAutomationBadges,
		useDataTableViewport: () => tableFits,
		useOrganizationPaginatedQuery: (_query: unknown, args: () => Record<string, unknown>) => {
			listArgs = args;
			return { ...paginatedResult([]), results: rows };
		},
		// Reverting to the ungated query would reach this and fail the mount.
		usePaginatedQuery: () => {
			throw new Error('the automations list must read through useOrganizationPaginatedQuery');
		},
		useOrganizationQuery: (query: unknown) =>
			nameOf(query).endsWith('countByStatus')
				? queryResult({ total: 3, active: 1, paused: 1, draft: 1 })
				: queryResult(null),
		useBackendOperation: (op: unknown) => ({
			run: nameOf(op).endsWith(':remove') ? removeAutomation : vi.fn(),
			isLoading: ref(false),
			error: ref(null),
		}),
	});
});

async function mountList() {
	const wrapper = mount(AutomationsIndex, {
		global: {
			plugins: [createTestI18n()],
			components: {
				ListPageShell,
				ListSortMenu,
				AutomationsListTable,
				AutomationsRowActions,
				UiQueryBoundary,
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
				UiDropdownMenu: UiDropdownMenuStub,
				UiDropdownMenuItem: UiDropdownMenuItemStub,
				UiDropdownDivider: Blank,
				DashboardListSkeleton: Blank,
				Icon: Blank,
			},
		},
	});
	await flushPromises();
	return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountList>>;

const rowOf = (wrapper: Wrapper, name: string) =>
	wrapper.findAll('tbody tr, ul > li').find((row) => row.text().includes(name))!;

async function openDeleteFor(wrapper: Wrapper, name: string) {
	const item = rowOf(wrapper, name)
		.findAll('[role="menuitem"]')
		.find((b) => b.text() === 'Delete');
	await item!.trigger('click');
	await nextTick();
	return wrapper.get('[role="dialog"]');
}

const confirmButton = (dialog: ReturnType<Wrapper['get']>) =>
	dialog.findAll('button').find((b) => b.text() === 'Delete automation')!;

describe('automations list — status tabs', () => {
	it('exposes the selected tab to assistive technology, with the counts', async () => {
		const wrapper = await mountList();
		const tablist = wrapper.get('[role="tablist"]');
		expect(tablist.attributes('aria-label')).toBe('Automation status');
		const tabs = tablist.findAll('[role="tab"]');
		expect(tabs.map((t) => t.text().replace(/\s+/g, ' '))).toEqual([
			'All 3',
			'Active 1',
			'Paused 1',
			'Draft 1',
		]);
		expect(tabs.map((t) => t.attributes('aria-selected'))).toEqual([
			'true',
			'false',
			'false',
			'false',
		]);
		expect(listArgs()).toEqual({ status: undefined });
	});

	it('filters the list on the server by the selected tab', async () => {
		const wrapper = await mountList();
		const paused = wrapper.findAll('[role="tab"]').find((t) => t.text().startsWith('Paused'))!;
		await paused.trigger('click');
		expect(paused.attributes('aria-selected')).toBe('true');
		expect(listArgs()).toEqual({ status: 'paused' });
	});
});

describe('automations list — rows', () => {
	it('links each name to the detail page, and a draft to the builder', async () => {
		const wrapper = await mountList();
		const links = wrapper.findAll('tbody a').map((a) => [a.text(), a.attributes('href')]);
		expect(links).toEqual([
			['Welcome sequence', '/dashboard/automations/au_welcome'],
			['Re-engagement: 90 days quiet', '/dashboard/automations/au_reengage'],
			['Birthday greeting', '/dashboard/automations/au_draft/edit'],
		]);
	});

	it('renders a card list below md, with the same links and actions', async () => {
		tableFits.value = false;
		const wrapper = await mountList();
		expect(wrapper.find('table').exists()).toBe(false);
		const cards = wrapper.findAll('ul > li');
		expect(cards).toHaveLength(3);
		expect(cards[0]!.get('a').attributes('href')).toBe('/dashboard/automations/au_welcome');
		expect(cards[0]!.find('button[aria-label="Pause"]').exists()).toBe(true);
		expect(cards[0]!.find('button[aria-label="More actions"]').exists()).toBe(true);
	});

	it('offers Create automation when the list is empty', async () => {
		rows.value = [];
		const wrapper = await mountList();
		expect(wrapper.get('h2').text()).toBe('No automations yet');
		expect(wrapper.findAll('button').some((b) => b.text() === 'Create automation')).toBe(true);
	});
});

describe('automations list — delete', () => {
	it('offers no delete for a running automation', async () => {
		const wrapper = await mountList();
		const items = rowOf(wrapper, 'Welcome sequence')
			.findAll('[role="menuitem"]')
			.map((b) => b.text());
		expect(items).not.toContain('Delete');
	});

	it('confirms through UiConfirmationDialog and deletes on confirm', async () => {
		const wrapper = await mountList();
		const dialogComponent = wrapper.findComponent(UiConfirmationDialog);
		expect(dialogComponent.props('open')).toBe(false);

		const dialog = await openDeleteFor(wrapper, 'Re-engagement: 90 days quiet');
		expect(dialogComponent.props('variant')).toBe('danger');
		expect(dialog.text()).toContain('"Re-engagement: 90 days quiet"');
		expect(dialog.text()).not.toContain('must be paused');

		await confirmButton(dialog).trigger('click');
		await flushPromises();
		expect(removeAutomation).toHaveBeenCalledWith({ automationId: 'au_reengage' });
		expect(dialogComponent.props('open')).toBe(false);
	});

	it('refuses an automation that turned active while the dialog was open', async () => {
		const wrapper = await mountList();
		const dialog = await openDeleteFor(wrapper, 'Re-engagement: 90 days quiet');
		expect(confirmButton(dialog).attributes('disabled')).toBeUndefined();

		// The row is live: someone activates it from another tab.
		rows.value = [WELCOME, { ...REENGAGE, status: 'active' }, DRAFT];
		await nextTick();

		const blocked = wrapper.get('[role="dialog"]');
		expect(blocked.text()).toContain('Active automations must be paused before deletion.');
		expect(confirmButton(blocked).attributes('disabled')).toBeDefined();
		await confirmButton(blocked).trigger('click');
		await flushPromises();
		expect(removeAutomation).not.toHaveBeenCalled();
	});
});
