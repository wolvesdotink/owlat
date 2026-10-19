import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, type VNode } from 'vue';
import DropdownMenu from '../components/ui/DropdownMenu.vue';
import DropdownMenuItem from '../components/ui/DropdownMenuItem.vue';
import Modal from '../components/ui/Modal.vue';
import { createUiI18n } from './i18n';

const IconStub = { name: 'Icon', setup: () => () => h('i') };

function press(target: Element | null, key: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	target!.dispatchEvent(event);
	return event;
}

const focused = () => document.activeElement as HTMLElement | null;
const item = (label: string) =>
	Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]')).find(
		(el) => el.textContent?.trim() === label
	)!;

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

/** A menu as the app mounts it: v-model:open, between two page controls. */
function mountMenu(items: () => VNode[], { inModal = false } = {}) {
	const open = ref(false);
	const menu = () =>
		h(
			DropdownMenu,
			{ open: open.value, 'onUpdate:open': (next: boolean) => (open.value = next) },
			{ trigger: () => h('button', { id: 'trigger' }, 'More actions'), default: items }
		);
	const Host = defineComponent({
		setup: () => () => {
			const page = [
				h('button', { id: 'before' }, 'Before'),
				menu(),
				h('button', { id: 'after' }, 'After'),
			];
			return inModal ? h(Modal, { open: true, title: 'Edit contact' }, () => page) : h('div', page);
		},
	});
	wrapper = mount(Host, {
		attachTo: document.body,
		global: { plugins: [createUiI18n('en')], components: { Icon: IconStub } },
	});
	return open;
}

const trigger = () => document.getElementById('trigger')!;

async function openByClick() {
	trigger().click();
	await nextTick();
	await nextTick();
}

const actions = () => [
	h(DropdownMenuItem, { disabled: true }, () => 'Archive'),
	h(DropdownMenuItem, null, () => 'Duplicate'),
	h('button', { role: 'menuitemcheckbox', 'aria-checked': 'true' }, 'Pinned'),
	h('button', { role: 'menuitem', 'aria-disabled': 'true' }, 'Export'),
	h(DropdownMenuItem, { role: 'menuitemradio', 'aria-checked': 'false' }, () => 'Closed'),
	h(DropdownMenuItem, { danger: true }, () => 'Delete'),
	h(DropdownMenuItem, { disabled: true }, () => 'Restore'),
];

describe('DropdownMenu keyboard', () => {
	it('focuses the first enabled item on open and keeps the items out of the tab order', async () => {
		mountMenu(actions);
		await openByClick();
		expect(focused()).toBe(item('Duplicate'));
		for (const label of ['Archive', 'Duplicate', 'Closed', 'Delete', 'Restore']) {
			expect(item(label).tabIndex, label).toBe(-1);
		}
	});

	it('moves between enabled items with the arrows, wrapping, and skips disabled ones', async () => {
		mountMenu(actions);
		await openByClick();
		const order: string[] = [];
		for (let i = 0; i < 5; i++) {
			expect(press(focused(), 'ArrowDown').defaultPrevented).toBe(true);
			order.push(focused()!.textContent!.trim());
		}
		expect(order).toEqual(['Pinned', 'Closed', 'Delete', 'Duplicate', 'Pinned']);

		press(focused(), 'ArrowUp');
		press(focused(), 'ArrowUp');
		expect(focused()).toBe(item('Delete'));
	});

	it('moves to the first and last enabled item with Home and End', async () => {
		mountMenu(actions);
		await openByClick();
		expect(press(focused(), 'End').defaultPrevented).toBe(true);
		expect(focused()).toBe(item('Delete'));
		expect(press(focused(), 'Home').defaultPrevented).toBe(true);
		expect(focused()).toBe(item('Duplicate'));
	});

	it('closes on Tab and leaves the press to the browser, from the trigger', async () => {
		const open = mountMenu(actions);
		await openByClick();
		const tab = press(focused(), 'Tab');
		// Not prevented: the browser moves focus on from where focus is when the
		// press is handled, the trigger, to the control after it.
		expect(tab.defaultPrevented).toBe(false);
		expect(focused()).toBe(trigger());
		expect(open.value).toBe(false);
		await nextTick();
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});

	it('closes on Shift+Tab the same way', async () => {
		const open = mountMenu(actions);
		await openByClick();
		const tab = press(focused(), 'Tab', { shiftKey: true });
		expect(tab.defaultPrevented).toBe(false);
		expect(focused()).toBe(trigger());
		expect(open.value).toBe(false);
	});

	it('closes on Escape and returns focus to the trigger', async () => {
		const open = mountMenu(actions);
		await openByClick();
		press(focused(), 'ArrowDown');
		expect(press(focused(), 'Escape').defaultPrevented).toBe(true);
		expect(open.value).toBe(false);
		expect(focused()).toBe(trigger());
	});

	it('leaves the arrows, Home and End to a field inside the menu', async () => {
		mountMenu(() => [
			h('input', { id: 'filter', 'aria-label': 'Filter' }),
			h(DropdownMenuItem, null, () => 'Duplicate'),
			h(DropdownMenuItem, null, () => 'Delete'),
		]);
		await openByClick();
		const field = document.getElementById('filter')!;
		field.focus();
		for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
			expect(press(field, key).defaultPrevented, key).toBe(false);
			expect(focused()).toBe(field);
		}
	});

	it('closes when Tab leaves a field inside the menu', async () => {
		const open = mountMenu(() => [
			h('input', { id: 'filter', 'aria-label': 'Filter' }),
			h(DropdownMenuItem, null, () => 'Duplicate'),
		]);
		await openByClick();
		document.getElementById('filter')!.focus();
		expect(press(focused(), 'Tab').defaultPrevented).toBe(false);
		expect(open.value).toBe(false);
	});

	it('leaves the arrows to a dialog field opened over the menu', async () => {
		const open = mountMenu(actions);
		await openByClick();
		// A later overlay, teleported outside the menu, with the menu still open.
		const dialog = document.createElement('div');
		dialog.setAttribute('role', 'dialog');
		const field = document.createElement('input');
		dialog.append(field);
		document.body.append(dialog);
		field.focus();
		for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab']) {
			expect(press(field, key).defaultPrevented, key).toBe(false);
			expect(focused()).toBe(field);
		}
		expect(open.value).toBe(true);
	});

	it('inside a dialog, Tab moves on from the trigger instead of being thrown to the first control', async () => {
		const open = mountMenu(actions, { inModal: true });
		await nextTick();
		await openByClick();
		expect(focused()).toBe(item('Duplicate'));
		const tab = press(focused(), 'Tab');
		// The dialog's trap sees focus on the trigger, inside it and not its last
		// control, so it leaves the press alone too.
		expect(tab.defaultPrevented).toBe(false);
		expect(focused()).toBe(trigger());
		expect(open.value).toBe(false);
	});
});
