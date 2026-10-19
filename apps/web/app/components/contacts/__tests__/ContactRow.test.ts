// @vitest-environment happy-dom
/**
 * ContactsContactRow: one row of the audience contacts table (plan 3.7).
 *   - renders the contact's cells, with a checkbox only for managers
 *   - the checkbox is a real, named checkbox whose checked state is the
 *     selection (plan OW-029), and toggling it never opens the contact
 *   - the right-click menu is handed to UiContextMenu as a getter, so nothing
 *     is built until it opens; it then reflects the row's current selection
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

import ContactRow from '../ContactRow.vue';
import UiCheckbox from '@owlat/ui/components/ui/Checkbox.vue';
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
			components: { UiCheckbox, UiContextMenu },
			stubs: { Icon: true },
			// A template global (Nuxt auto-import), so it reaches the row as a mock.
			mocks: { formatDate: () => 'Mar 3, 2026' },
		},
	});
	return { host, row: host.findComponent(ContactRow) };
}

/** The row's selection box, found by its role and its accessible name. */
const checkboxNamed = (host: ReturnType<typeof mountRow>['host'], name: string) =>
	host.get<HTMLInputElement>(`input[type="checkbox"][aria-label="${name}"]`);

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
		expect(host.find('input[type="checkbox"]').exists()).toBe(false);
		host.unmount();
	});

	it('toggles selection from the checkbox without opening the contact', async () => {
		const { host, row } = mountRow();
		const checkbox = checkboxNamed(host, 'Select ada@example.com');
		await checkbox.trigger('click');
		expect(row.emitted('toggle-select')).toHaveLength(1);
		expect(row.emitted('open')).toBeUndefined();

		// A click on the box's own label wrapper does not open the row either.
		await host.get('td label').trigger('click');
		expect(row.emitted('open')).toBeUndefined();

		await host.get('tr').trigger('click');
		expect(row.emitted('open')).toHaveLength(1);
		host.unmount();
	});

	it('paints the selected state from the boolean prop', () => {
		const { host } = mountRow({ selected: true });
		expect(host.get('tr').classes()).toContain('bg-brand/5');
		host.unmount();
	});

	it('exposes the selection as the checkbox state under one stable name', () => {
		const unselected = mountRow();
		expect(checkboxNamed(unselected.host, 'Select ada@example.com').element.checked).toBe(false);
		unselected.host.unmount();

		// Selected: same name, checked — the state is announced, not the label.
		const selected = mountRow({ selected: true });
		expect(checkboxNamed(selected.host, 'Select ada@example.com').element.checked).toBe(true);
		selected.host.unmount();
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
