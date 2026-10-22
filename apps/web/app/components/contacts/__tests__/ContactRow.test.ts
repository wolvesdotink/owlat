/**
 * ContactsContactRow: one row of the audience contacts table (plan 3.7).
 *   - renders the contact's cells, with a checkbox only for managers
 *   - the checkbox toggles selection without opening the contact
 *   - the right-click menu is handed to UiContextMenu as a getter, so nothing
 *     is built until it opens; it then reflects the row's current selection
 *   - the email is a real router link (plan OW-028): focusable, opened by the
 *     link itself, and a modified click is left to the browser
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterLink, type Router } from 'vue-router';

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

const pathOf = (id: string) => `/dashboard/audience/contacts/${id}`;

function testRouter(): Router {
	const Page = defineComponent({ render: () => null });
	return createRouter({
		history: createMemoryHistory(),
		routes: [
			{ path: '/dashboard/audience/contacts', component: Page },
			{ path: '/dashboard/audience/contacts/:id', component: Page },
		],
	});
}

function mountRow(
	props: { selected?: boolean; canManage?: boolean; contact?: Partial<typeof contact> } = {},
	rows: (typeof contact)[] = [contact],
	router: Router = testRouter()
) {
	// A row renders a <tr>, so it is mounted inside a real table body.
	const Host = defineComponent({
		setup() {
			return () =>
				h('table', [
					h(
						'tbody',
						rows.map((row) =>
							h(ContactRow, {
								key: row._id,
								to: pathOf(row._id),
								selected: false,
								canManage: true,
								...props,
								contact: { ...row, ...props.contact },
							})
						)
					),
				]);
		},
	});
	const host = mount(Host, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n(), router],
			// The real router link, so navigation and modified clicks are vue-router's.
			components: { UiContextMenu, NuxtLink: RouterLink },
			stubs: { Icon: true },
			// A template global (Nuxt auto-import), so it reaches the row as a mock.
			mocks: { formatDate: () => 'Mar 3, 2026' },
		},
	});
	return { host, row: host.findComponent(ContactRow), router };
}

/** Focusable in sequential (Tab) order: native controls without a negative tabindex. */
const tabbables = (root: Element) =>
	Array.from(root.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex]')).filter(
		(el) => el.tabIndex >= 0
	);

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
		const { host, row, router } = mountRow();
		await router.push('/dashboard/audience/contacts');
		const checkbox = host.get('input[type="checkbox"][aria-label="Select ada@example.com"]');
		await checkbox.trigger('click');
		await flushPromises();
		expect(row.emitted('toggle-select')).toHaveLength(1);
		expect(row.emitted('open')).toBeUndefined();
		expect(router.currentRoute.value.path).toBe('/dashboard/audience/contacts');

		await host.get('tr').trigger('click');
		expect(row.emitted('open')).toHaveLength(1);
		host.unmount();
	});

	it('puts one link per row in the Tab order, after its checkbox', () => {
		const rows = [contact, { ...contact, _id: 'contact_2' as never, email: 'bo@example.com' }];
		const { host } = mountRow({}, rows);
		const order = tabbables(host.element).map(
			(el) =>
				`${el.tagName.toLowerCase()}:${el.getAttribute('href') ?? el.getAttribute('aria-label')}`
		);
		expect(order).toEqual([
			'input:Select ada@example.com',
			`a:${pathOf('contact_1')}`,
			'input:Select bo@example.com',
			`a:${pathOf('contact_2')}`,
		]);
		// The link carries the email as its name; the row itself is not a stop.
		expect(host.get(`a[href="${pathOf('contact_1')}"]`).text()).toBe('ada@example.com');
		expect(host.find('tr[tabindex]').exists()).toBe(false);

		const link = host.get<HTMLAnchorElement>(`a[href="${pathOf('contact_2')}"]`).element;
		link.focus();
		expect(document.activeElement).toBe(link);
		host.unmount();
	});

	it.each([
		['the full name', { firstName: 'Ada', lastName: 'Lovelace' }, 'Ada Lovelace'],
		['the unnamed label', { firstName: null, lastName: null }, 'Unnamed contact'],
	])('names the link of an email-less contact with %s', (_label, name, expected) => {
		const { host } = mountRow({}, [{ ...contact, email: undefined, ...name } as never]);
		const link = host.get(`a[href="${pathOf('contact_1')}"]`);
		expect(link.text()).toBe(expected);
		host.unmount();
	});

	it('opens the contact through the link once, without a second row open', async () => {
		const { host, row, router } = mountRow();
		await router.push('/dashboard/audience/contacts');
		// Enter on a focused link is a click on it (HTML activation behaviour).
		await host.get('a').trigger('click');
		await flushPromises();
		expect(router.currentRoute.value.path).toBe(pathOf('contact_1'));
		expect(row.emitted('open')).toBeUndefined();
		host.unmount();
	});

	it.each([
		['Ctrl', { ctrlKey: true }],
		['Cmd', { metaKey: true }],
		['Shift', { shiftKey: true }],
		['middle button', { button: 1 }],
	])('leaves a %s click on the link to the browser', async (_label, init) => {
		const { host, row, router } = mountRow();
		await router.push('/dashboard/audience/contacts');
		const link = host.get('a').element;
		// Swallowed at the document so happy-dom does not follow the href itself.
		let defaultPrevented: boolean | undefined;
		const spy = (event: Event) => {
			defaultPrevented = event.defaultPrevented;
			event.preventDefault();
		};
		document.addEventListener('click', spy);
		link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
		document.removeEventListener('click', spy);
		await flushPromises();
		expect(defaultPrevented).toBe(false);
		expect(router.currentRoute.value.path).toBe('/dashboard/audience/contacts');
		expect(row.emitted('open')).toBeUndefined();
		host.unmount();
	});

	it('opens from a plain click on the row body but not a modified one', async () => {
		const { host, row } = mountRow();
		const nameCell = host.findAll('td')[2]!;
		await nameCell.trigger('click', { ctrlKey: true });
		await nameCell.trigger('click', { metaKey: true });
		expect(row.emitted('open')).toBeUndefined();
		await nameCell.trigger('click');
		expect(row.emitted('open')).toHaveLength(1);
		host.unmount();
	});

	it('opens the row menu from the keyboard menu key on the focused link', async () => {
		const { host } = mountRow();
		await host.get('a').trigger('keydown', { key: 'F10', shiftKey: true });
		expect(menuLabels()).toEqual(['Open contact', 'Copy email address', 'Select']);
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

	// Plan OW-037: the email is optional, so the row falls back to the name,
	// then to "Unnamed contact", in both its visible cell and its checkbox name.
	// Under the "Email" header, a fallback cell also says "No email".
	it.each([
		['an email', {}, 'ada@example.com', 'ada@example.com'],
		[
			'a name but no email',
			{ email: undefined, lastName: 'Lovelace' },
			'Ada Lovelace',
			'Ada Lovelace No email',
		],
		[
			'no email and no name',
			{ email: undefined, firstName: null },
			'Unnamed contact',
			'Unnamed contact No email',
		],
	])('labels a contact with %s by its primary identity', (_case, override, label, cell) => {
		const { host } = mountRow({ contact: override });
		expect(host.findAll('td')[1]?.text()).toBe(cell);
		const box = `input[type="checkbox"][aria-label="Select ${label}"]`;
		expect(host.get<HTMLInputElement>(box).element.checked).toBe(false);
		host.unmount();

		// Selected: the same name, now checked.
		const selected = mountRow({ contact: override, selected: true });
		expect(selected.host.get<HTMLInputElement>(box).element.checked).toBe(true);
		selected.host.unmount();
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
