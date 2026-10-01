import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import DropdownMenu from '../components/ui/DropdownMenu.vue';
import Modal from '../components/ui/Modal.vue';
import { createUiI18n } from './i18n';

const IconStub = { name: 'Icon', setup: () => () => h('i') };

const escape = (target: Element | null) => {
	const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
	target!.dispatchEvent(event);
	return event;
};

it('Escape closes the menu and restores focus without running the page shortcut', async () => {
	// Page shortcuts, registered before the menu: the app-wide dispatcher on the
	// document and a page handler on the window, both in the bubble phase.
	const pageShortcut = vi.fn();
	const documentShortcut = vi.fn();
	window.addEventListener('keydown', pageShortcut);
	document.addEventListener('keydown', documentShortcut);
	const wrapper = mount(DropdownMenu, {
		attachTo: document.body,
		slots: {
			trigger: '<button>More actions</button>',
			default: '<button role="menuitem">Create contact</button>',
		},
	});
	try {
		await wrapper.get('button').trigger('click');
		expect(wrapper.emitted('update:open')?.at(-1)).toEqual([true]);
		await wrapper.setProps({ open: true });
		await nextTick();
		const event = escape(document.querySelector('[role="menuitem"]'));
		await nextTick();
		expect(event.defaultPrevented).toBe(true);
		expect(pageShortcut).not.toHaveBeenCalled();
		expect(documentShortcut).not.toHaveBeenCalled();
		expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
		await wrapper.setProps({ open: false });
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(wrapper.get('button').element);
	} finally {
		wrapper.unmount();
		window.removeEventListener('keydown', pageShortcut);
		document.removeEventListener('keydown', documentShortcut);
	}
});

/**
 * UiModal handles Escape too. Escape belongs to the innermost open layer: the
 * menu first, then the dialog, so one press never throws away the dialog.
 */
describe('DropdownMenu inside UiModal', () => {
	function mountInModal() {
		const modalOpen = ref(true);
		const menuOpen = ref(false);
		const Host = defineComponent({
			setup: () => () =>
				h(
					Modal,
					{
						open: modalOpen.value,
						title: 'Edit contact',
						'onUpdate:open': (next: boolean) => (modalOpen.value = next),
					},
					{
						default: () =>
							h(
								DropdownMenu,
								{
									open: menuOpen.value,
									'onUpdate:open': (next: boolean) => (menuOpen.value = next),
								},
								{
									trigger: () => h('button', { id: 'row-actions' }, 'More actions'),
									default: () => h('button', { role: 'menuitem' }, 'Duplicate'),
								}
							),
					}
				),
		});
		const wrapper = mount(Host, {
			attachTo: document.body,
			global: { plugins: [createUiI18n('en')], components: { Icon: IconStub } },
		});
		return { wrapper, modalOpen, menuOpen };
	}

	const menuTrigger = () => document.getElementById('row-actions')!;

	it('closes the menu on the first Escape and the dialog on the second', async () => {
		const { wrapper, modalOpen, menuOpen } = mountInModal();
		try {
			await nextTick();
			menuTrigger().click();
			await nextTick();
			await nextTick();
			const item = document.querySelector<HTMLElement>('[role="menuitem"]')!;
			expect(menuOpen.value).toBe(true);
			expect(document.activeElement).toBe(item);

			const first = escape(item);
			await nextTick();
			expect(first.defaultPrevented).toBe(true);
			expect(menuOpen.value).toBe(false);
			expect(modalOpen.value).toBe(true);
			expect(document.querySelector('[role="menu"]')).toBeNull();
			expect(document.activeElement).toBe(menuTrigger());

			escape(document.activeElement);
			await nextTick();
			expect(modalOpen.value).toBe(false);
		} finally {
			wrapper.unmount();
		}
	});

	it('still closes the dialog on Escape while the menu is closed', async () => {
		const { wrapper, modalOpen, menuOpen } = mountInModal();
		try {
			await nextTick();
			menuTrigger().focus();
			escape(menuTrigger());
			await nextTick();
			expect(menuOpen.value).toBe(false);
			expect(modalOpen.value).toBe(false);
		} finally {
			wrapper.unmount();
		}
	});
});
