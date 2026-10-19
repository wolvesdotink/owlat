// @vitest-environment happy-dom
/**
 * ContactsContactRow: one row of the audience contacts table (plan 3.7).
 *   - renders the contact's cells, with a checkbox only for managers
 *   - the checkbox toggles selection without opening the contact
 *   - the right-click menu is handed to UiContextMenu as a getter, so nothing
 *     is built until it opens; it then reflects the row's current selection
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

import ContactRow from '../ContactRow.vue';
import UiContextMenu from '@owlat/ui/components/ui/ContextMenu.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const showToast = vi.fn();

beforeEach(() => {
	showToast.mockReset();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useToast', () => ({ showToast }));
});

const contact = {
	_id: 'contact_1' as never,
	email: 'ada@example.com',
	firstName: 'Ada',
	lastName: null,
	createdAt: 0,
};

function mountRow(props: { selected?: boolean; canManage?: boolean } = {}) {
	// A row renders a <tr>, so it is mounted inside a real table body.
	const Host = defineComponent({
		setup() {
			return () =>
				h('table', [
					h('tbody', [h(ContactRow, { contact, selected: false, canManage: true, ...props })]),
				]);
		},
	});
	const host = mount(Host, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { UiContextMenu },
			stubs: { Icon: true },
			// A template global (Nuxt auto-import), so it reaches the row as a mock.
			mocks: { formatDate: () => 'Mar 3, 2026' },
		},
	});
	return { host, row: host.findComponent(ContactRow) };
}

const menuLabels = () =>
	Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((el) =>
		el.textContent?.trim()
	);

describe('ContactsContactRow', () => {
	it('renders the contact cells, with a dash for a missing name part', () => {
		const { host } = mountRow();
		const cells = host.findAll('td').map((td) => td.text());
		expect(cells).toEqual(['', 'ada@example.com', 'Ada', '-', 'Mar 3, 2026']);
		host.unmount();
	});

	it('shows no checkbox column without manage permission', () => {
		const { host } = mountRow({ canManage: false });
		expect(host.findAll('td')).toHaveLength(4);
		expect(host.find('button').exists()).toBe(false);
		host.unmount();
	});

	it('toggles selection from the checkbox without opening the contact', async () => {
		const { host, row } = mountRow();
		const checkbox = host.get('input[type="checkbox"][aria-label="Select ada@example.com"]');
		await checkbox.trigger('click');
		expect(row.emitted('toggle-select')).toHaveLength(1);
		expect(row.emitted('open')).toBeUndefined();

		await host.get('tr').trigger('click');
		expect(row.emitted('open')).toHaveLength(1);
		host.unmount();
	});

	it('paints the selected state from the boolean prop', () => {
		const { host } = mountRow({ selected: true });
		expect(host.get('tr').classes()).toContain('bg-brand/5');
		expect(host.get<HTMLInputElement>('input[type="checkbox"]').element.checked).toBe(true);
		host.unmount();
	});

	it('hands the menu over as a getter instead of a per-render array', () => {
		const { host } = mountRow();
		expect(typeof host.findComponent(UiContextMenu).props('items')).toBe('function');
		host.unmount();
	});

	it('builds the menu on open, matching the current selection', async () => {
		const { host, row } = mountRow();
		expect(menuLabels()).toEqual([]);

		await host.get('tr').trigger('contextmenu', { clientX: 5, clientY: 5 });
		expect(menuLabels()).toEqual(['Open contact', 'Copy email address', 'Select']);

		const open = document.body.querySelector<HTMLElement>('[role="menuitem"]');
		open?.click();
		expect(row.emitted('open')).toHaveLength(1);
		host.unmount();
	});

	it('offers Deselect for a selected row and no select item for viewers', async () => {
		const selected = mountRow({ selected: true });
		await selected.host.get('tr').trigger('contextmenu', { clientX: 5, clientY: 5 });
		expect(menuLabels()).toEqual(['Open contact', 'Copy email address', 'Deselect']);
		selected.host.unmount();

		const viewer = mountRow({ canManage: false });
		await viewer.host.get('tr').trigger('contextmenu', { clientX: 5, clientY: 5 });
		expect(menuLabels()).toEqual(['Open contact', 'Copy email address']);
		viewer.host.unmount();
	});
});

/**
 * The selection box is a real checkbox (plan OW-029): one stable name per
 * contact, the selection carried as its checked state, and a click on the box
 * or its label never opens the row.
 */
describe('ContactsContactRow selection checkbox', () => {
	const box = (host: ReturnType<typeof mountRow>['host']) =>
		host.get<HTMLInputElement>('td input[type="checkbox"]');

	it('keeps one name and reports the selection as checked', () => {
		const unselected = mountRow();
		expect(box(unselected.host).attributes('aria-label')).toBe('Select ada@example.com');
		expect(box(unselected.host).element.checked).toBe(false);
		unselected.host.unmount();

		const selected = mountRow({ selected: true });
		expect(box(selected.host).attributes('aria-label')).toBe('Select ada@example.com');
		expect(box(selected.host).element.checked).toBe(true);
		selected.host.unmount();
	});

	it('toggles from the box or its label without opening the contact', async () => {
		const { host, row } = mountRow();
		await box(host).trigger('click');
		await host.get('td label').trigger('click');
		expect(row.emitted('toggle-select')?.length).toBeGreaterThan(0);
		expect(row.emitted('open')).toBeUndefined();
		host.unmount();
	});

	it('shows no checkbox to a viewer', () => {
		const { host } = mountRow({ canManage: false });
		expect(host.find('input[type="checkbox"]').exists()).toBe(false);
		host.unmount();
	});
});
