/**
 * Accessibility contract for the clickable <div @click> / <tr @click> rows on
 * the delivery (webhooks) and send (marketing, transactional) pages. They are exposed to assistive tech
 * and the keyboard as real buttons: focusable (tabindex="0"), announced
 * (role="button"), operable with Enter and Space, and — for the expandable
 * delivery row — reflecting open/closed state via aria-expanded.
 *
 * The rows are MOUNTED and driven with real keyboard events. The domain row is
 * no longer one of them: its header is a native disclosure button beside its
 * action buttons, pinned in `components/domains/__tests__/recordRowDisclosure.test.ts`.
 * The marketing and transactional lists share one
 * grid card and one table row (`components/send/TemplateGrid.vue`,
 * `TemplateTable.vue`) and one sort menu (`components/list/ListSortMenu.vue`).
 *
 * The segment and topic lists share `components/audience/AudienceListTable.vue`.
 * Its rows are not buttons: the keyboard route to an item is the link on its
 * name. A mouse-only `<tr @click>` would leave the topic table with no keyboard
 * route at all, and its edit/delete buttons must show a focus ring.
 *
 * The automations list (`components/automations/ListTable.vue`, with
 * `RowActions.vue` in both layouts) follows the same rule. Its names are
 * links, not a mouse-only `<span @click>`.
 */
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, nextTick, useSlots, type Component } from 'vue';
import { mount } from '@vue/test-utils';
import WebhookRow from '~/components/webhooks/WebhookRow.vue';
import TemplateGrid from '~/components/send/TemplateGrid.vue';
import TemplateTable from '~/components/send/TemplateTable.vue';
import TemplateActionsMenu from '~/components/send/TemplateActionsMenu.vue';
import TemplateStatusBadge from '~/components/send/TemplateStatusBadge.vue';
import ListSortMenu from '~/components/list/ListSortMenu.vue';
import AudienceListTable from '~/components/audience/AudienceListTable.vue';
import AutomationsListTable, {
	type AutomationListItem,
} from '~/components/automations/ListTable.vue';
import AutomationsRowActions from '~/components/automations/RowActions.vue';
import { useAutomationBadges } from '~/composables/useAutomationBadges';
import UiCard from '@owlat/ui/components/ui/Card.vue';
import UiSwitch from '@owlat/ui/components/ui/Switch.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatDate } from '~/utils/formatters';

Object.assign(globalThis, {
	useI18n: i18nStubs.useI18n,
	formatDate,
	useClickOutsideSelector: vi.fn(),
	useSlots,
	useAutomationBadges,
});

const rowStubs = {
	Icon: { template: '<i />' },
	UiIconBox: { template: '<i />' },
	UiBadge: { template: '<span><slot /></span>' },
};

function mountWebhookRow() {
	return mount(WebhookRow, {
		props: {
			webhook: {
				_id: 'webhook_1',
				name: 'Order events',
				url: 'https://hooks.example.com/orders',
				events: [],
				isActive: true,
				createdAt: 0,
				updatedAt: 0,
			},
			expanded: true,
			toggling: false,
			sendingTest: false,
		} as never,
		global: { plugins: [createTestI18n()], stubs: rowStubs, mocks: { formatDate } },
	});
}

describe.each([
	['webhooks', mountWebhookRow, 'toggleExpanded', 'webhook-details-webhook_1'],
] as const)('%s row header', (_name, mountRow, event, panelId) => {
	it('is a focusable button that names its state and its panel', () => {
		const header = mountRow().get('[role="button"]');
		expect(header.attributes('tabindex')).toBe('0');
		expect(header.attributes('aria-expanded')).toBeDefined();
		expect(header.attributes('aria-controls')).toBe(panelId);
		expect(header.attributes('aria-label')).toBeTruthy();
	});

	it('toggles on Enter and on Space, and Space does not scroll the page', async () => {
		const wrapper = mountRow();
		const header = wrapper.get('[role="button"]');
		await header.trigger('keydown', { key: 'Enter' });
		expect(wrapper.emitted(event)).toHaveLength(1);
		const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
		header.element.dispatchEvent(space);
		await wrapper.vm.$nextTick();
		expect(wrapper.emitted(event)).toHaveLength(2);
		expect(space.defaultPrevented).toBe(true);
	});
});

const template = {
	_id: 'tpl_1',
	name: 'Welcome',
	subject: 'Hello',
	status: 'published' as const,
	createdAt: 0,
	updatedAt: 0,
};

const apiCodeAction = {
	key: 'api-code',
	icon: 'lucide:code',
	label: 'View API code',
	overlay: true,
	inline: true,
	run: vi.fn(),
};

const sendStubs = {
	UiCard,
	SendTemplateActionsMenu: TemplateActionsMenu,
	SendTemplateStatusBadge: TemplateStatusBadge,
	UiDropdownMenu: { template: '<div class="menu"><slot name="trigger" /><slot /></div>' },
	UiDropdownMenuItem: { template: '<button type="button" class="menu-item"><slot /></button>' },
	UiDropdownDivider: { template: '<hr />' },
};

function mountSend(component: Component, props: Record<string, unknown> = {}) {
	return mount(component, {
		props: { items: [template], canManage: true, actions: [apiCodeAction], ...props },
		slots: { cells: '<td>Welcome</td>' },
		global: { plugins: [createTestI18n()], components: sendStubs },
	});
}

describe.each([
	['grid card', () => mountSend(TemplateGrid)],
	['table row', () => mountSend(TemplateTable, { columns: ['Name'] })],
] as const)('send template %s', (_name, mountRow) => {
	it('is a focusable button named after the template', () => {
		const row = mountRow().get('[role="button"]');
		expect(row.attributes('tabindex')).toBe('0');
		expect(row.attributes('aria-label')).toBe('Edit Welcome');
	});

	it('opens on Enter and on Space, and Space does not scroll the page', async () => {
		const wrapper = mountRow();
		const row = wrapper.get('[role="button"]');
		await row.trigger('keydown', { key: 'Enter' });
		expect(wrapper.emitted('edit')).toEqual([[template]]);
		const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
		row.element.dispatchEvent(space);
		await nextTick();
		expect(wrapper.emitted('edit')).toHaveLength(2);
		expect(space.defaultPrevented).toBe(true);
	});

	it('does not open when a nested control is activated from the keyboard', async () => {
		const wrapper = mountRow();
		const nested = wrapper.get('[role="button"]').get('button');
		await nested.trigger('keydown', { key: 'Enter' });
		await nested.trigger('keydown', { key: ' ' });
		expect(wrapper.emitted('edit')).toBeUndefined();
	});

	it('does not open when a nested control is clicked', async () => {
		const wrapper = mountRow();
		await wrapper.get('button[aria-label="View API code"]').trigger('click');
		expect(apiCodeAction.run).toHaveBeenCalledWith(template);
		expect(wrapper.emitted('edit')).toBeUndefined();
	});

	it('labels its icon-only controls', () => {
		const wrapper = mountRow();
		for (const label of ['View API code', 'Edit', 'More actions']) {
			expect(wrapper.find(`button[aria-label="${label}"]`).exists(), label).toBe(true);
		}
	});
});

describe('the list sort menu exposes listbox semantics linked to its trigger', () => {
	it('links trigger and listbox and announces the selected option', async () => {
		const wrapper = mount(ListSortMenu, {
			props: {
				options: [
					{ value: 'updatedAt-desc', label: 'shared.templateList.sort.updatedDesc' },
					{ value: 'name-asc', label: 'shared.templateList.sort.nameAsc' },
				],
				modelValue: 'name-asc',
				label: 'Sort templates',
				listboxId: 'marketing-sort-listbox',
			},
			global: { plugins: [createTestI18n()] },
		});
		const trigger = wrapper.get('button[aria-haspopup="listbox"]');
		expect(trigger.attributes('aria-controls')).toBe('marketing-sort-listbox');
		expect(trigger.attributes('aria-expanded')).toBe('false');

		await trigger.trigger('click');
		expect(trigger.attributes('aria-expanded')).toBe('true');
		const listbox = wrapper.get('[role="listbox"]');
		expect(listbox.attributes('id')).toBe('marketing-sort-listbox');
		const options = listbox.findAll('[role="option"]');
		expect(options.map((o) => o.attributes('aria-selected'))).toEqual(['false', 'true']);

		await options[0]!.trigger('click');
		expect(wrapper.emitted('update:modelValue')).toEqual([['updatedAt-desc']]);
		expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
	});
});

describe.each(['table', 'cards'] as const)('audience list %s', (layout) => {
	const topic = {
		_id: 'tp_1',
		name: 'Product updates',
		description: 'Release notes',
		contactCount: 12,
		createdAt: 0,
	};

	function mountList() {
		return mount(AudienceListTable as Component, {
			props: {
				items: [topic],
				layout,
				icon: 'lucide:list',
				itemTo: (item: { _id: string }) => `/dashboard/audience/topics/${item._id}`,
				countOf: (item: { contactCount: number }) => item.contactCount,
				countField: 'contactCount',
				countHeader: 'Contacts',
				createdHeader: 'Created',
				totalText: '1 topic',
				editLabel: 'Edit topic',
				deleteLabel: 'Delete topic',
				canManage: true,
				getSortIcon: () => null,
				getAriaSort: () => undefined,
			},
			global: { plugins: [createTestI18n()], stubs: rowStubs },
		});
	}

	it('reaches the item through a focusable link on its name', () => {
		const link = mountList().get('a[href="/dashboard/audience/topics/tp_1"]');
		expect(link.text()).toContain('Product updates');
		expect(link.classes()).toContain('focus-visible:ring-2');
	});

	it('gives the edit and delete buttons a name and a focus ring', async () => {
		const wrapper = mountList();
		for (const [label, event] of [
			['Edit topic', 'edit'],
			['Delete topic', 'delete'],
		] as const) {
			const button = wrapper.get(`button[aria-label="${label}"]`);
			expect(button.classes()).toContain('focus-visible:ring-2');
			await button.trigger('click');
			expect(wrapper.emitted(event)).toEqual([[topic]]);
		}
	});
});

describe.each(['table', 'cards'] as const)('automations list %s', (layout) => {
	const paused = {
		_id: 'au_1',
		name: 'Re-engagement: 90 days quiet',
		status: 'paused',
		triggerType: 'contact_created',
		statsActive: 0,
	} as AutomationListItem;
	const draft = {
		...paused,
		_id: 'au_2',
		name: 'Birthday greeting',
		status: 'draft',
	} as AutomationListItem;

	function mountList(canManage = true) {
		const onToggle = vi.fn();
		const onEdit = vi.fn();
		const Harness = defineComponent({
			setup: () => () =>
				h(
					AutomationsListTable,
					{ items: [paused, draft], layout, canManage, health: new Map() },
					{
						actions: (slot: { automation: AutomationListItem; touch: boolean }) =>
							h(AutomationsRowActions, {
								automation: slot.automation,
								canManage,
								toggling: false,
								touch: slot.touch,
								onToggle,
								onEdit,
							}),
					}
				),
		});
		const wrapper = mount(Harness, {
			global: {
				plugins: [createTestI18n()],
				components: { UiSwitch },
				stubs: {
					...rowStubs,
					UiDropdownMenu: sendStubs.UiDropdownMenu,
					UiDropdownMenuItem: sendStubs.UiDropdownMenuItem,
					UiDropdownDivider: sendStubs.UiDropdownDivider,
				},
			},
		});
		return { wrapper, onToggle, onEdit };
	}

	it('reaches the automation through a focusable link on its name', () => {
		const { wrapper } = mountList();
		const link = wrapper.get('a[href="/dashboard/automations/au_1"]');
		expect(link.text()).toBe('Re-engagement: 90 days quiet');
		expect(link.classes()).toContain('focus-visible:ring-2');
		// A draft has no analytics yet: its name opens the builder.
		expect(wrapper.get('a[href="/dashboard/automations/au_2/edit"]').text()).toBe(
			'Birthday greeting'
		);
	});

	it("leaves a draft's name plain for a member who cannot edit it", () => {
		const { wrapper } = mountList(false);
		expect(wrapper.find('a[href="/dashboard/automations/au_1"]').exists()).toBe(true);
		expect(wrapper.findAll('a').map((a) => a.text())).not.toContain('Birthday greeting');
		expect(wrapper.text()).toContain('Birthday greeting');
	});

	it('gives the row actions a name and a focus ring', async () => {
		const { wrapper, onToggle, onEdit } = mountList();
		const row = wrapper.findAll(layout === 'table' ? 'tbody tr' : 'li')[0]!;
		for (const label of ['Edit', 'More actions']) {
			const button = row.get(`button[aria-label="${label}"]`);
			expect(button.classes()).toContain('focus-visible:ring-2');
		}
		// The pause/resume control is a switch named for the automation; its
		// state is aria-checked (off: this one is paused).
		const toggle = row.get('[role="switch"][aria-label="Active: Re-engagement: 90 days quiet"]');
		expect(toggle.attributes('aria-checked')).toBe('false');
		expect(toggle.classes()).toContain('focus-visible:ring-2');
		await toggle.trigger('click');
		await row.get('button[aria-label="Edit"]').trigger('click');
		expect(onToggle).toHaveBeenCalledWith(paused);
		expect(onEdit).toHaveBeenCalledWith(paused);
	});
});
