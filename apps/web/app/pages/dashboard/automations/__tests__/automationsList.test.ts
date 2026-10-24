/**
 * The automations list runs on the shared list scaffold (`ListPageShell` +
 * `useListPage`). Mounted with the real shell, segmented control, rows and row
 * actions, so the assertions are about what a user and a screen reader get:
 *   - the status tabs expose the selected one (`aria-selected`), carry their
 *     counts, and the selected tab reaches the server-side status filter;
 *   - the list reads through the organization-gated paginated query;
 *   - below `md` the rows are a card list whose names are links;
 *   - delete is offered only for an automation that is not running, runs at
 *     once (the automation goes to Recently deleted) and its toast names it and
 *     offers Undo, which restores it;
 *   - a right-click (or a long-press on the cards) opens the row's context
 *     menu with the overflow menu's verbs, in the same order, run by the same
 *     handlers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, useSlots } from 'vue';
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
const restoreAutomation = vi.fn(async (_args: unknown) => ({ ok: true, result: null }));
const showToast = vi.fn(
	(_message: string, _type?: string, _options?: { action?: { onAction: () => void } }) => 'toast-1'
);
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
	restoreAutomation.mockClear();
	showToast.mockClear();
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
			run: nameOf(op).endsWith(':remove')
				? removeAutomation
				: nameOf(op).endsWith(':restore')
					? restoreAutomation
					: vi.fn(),
			isLoading: ref(false),
			error: ref(null),
		}),
		useToast: () => ({
			showToast,
			removeToast: vi.fn(),
			setToastShortcutHint: vi.fn(),
			updateToast: vi.fn(),
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

async function deleteFromMenu(wrapper: Wrapper, name: string) {
	const item = rowOf(wrapper, name)
		.findAll('[role="menuitem"]')
		.find((b) => b.text() === 'Delete');
	await item!.trigger('click');
	await flushPromises();
}

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

	it('deletes at once and offers Undo, which restores the automation', async () => {
		const wrapper = await mountList();
		expect(wrapper.findComponent(UiConfirmationDialog).exists()).toBe(false);

		await deleteFromMenu(wrapper, 'Re-engagement: 90 days quiet');
		expect(removeAutomation).toHaveBeenCalledWith({ automationId: 'au_reengage' });
		expect(wrapper.find('[role="dialog"]').exists()).toBe(false);

		const [message, , options] = showToast.mock.calls.at(-1)!;
		expect(message).toBe('Deleted Re-engagement: 90 days quiet');
		options!.action!.onAction();
		await flushPromises();
		expect(restoreAutomation).toHaveBeenCalledWith({ automationId: 'au_reengage' });
	});
});

describe('automations list — row context menu', () => {
	const contextLabels = () =>
		Array.from(document.body.querySelectorAll('[role="menu"] [role="menuitem"]')).map((el) =>
			el.textContent?.trim()
		);

	it('offers the overflow menu’s verbs on right-click, and runs them', async () => {
		const wrapper = await mountList();
		for (const name of ['Welcome sequence', 'Re-engagement: 90 days quiet', 'Birthday greeting']) {
			const row = rowOf(wrapper, name);
			const overflow = row.findAll('.menu [role="menuitem"]').map((b) => b.text());
			await row.trigger('contextmenu', { clientX: 10, clientY: 10 });
			expect(contextLabels()).toEqual(overflow);
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
			await flushPromises();
		}

		await rowOf(wrapper, 'Re-engagement: 90 days quiet').trigger('contextmenu', {
			clientX: 10,
			clientY: 10,
		});
		const remove = Array.from(
			document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')
		).find((el) => el.textContent?.trim() === 'Delete');
		remove!.click();
		await flushPromises();
		expect(removeAutomation).toHaveBeenCalledWith({ automationId: 'au_reengage' });
		wrapper.unmount();
	});

	it('opens on a long-press on a card', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			tableFits.value = false;
			const wrapper = await mountList();
			const card = rowOf(wrapper, 'Welcome sequence').element;
			const down = new Event('pointerdown', { bubbles: true, cancelable: true });
			Object.defineProperties(down, {
				clientX: { value: 40 },
				clientY: { value: 40 },
				pointerType: { value: 'touch' },
				pointerId: { value: 1 },
				isPrimary: { value: true },
			});
			card.dispatchEvent(down);
			vi.advanceTimersByTime(500);
			await flushPromises();
			expect(contextLabels()).toEqual(['View details', 'Edit', 'Duplicate', 'Pause']);
			wrapper.unmount();
		} finally {
			vi.useRealTimers();
		}
	});
});
