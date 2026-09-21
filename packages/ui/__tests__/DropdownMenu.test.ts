import { expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DropdownMenu from '../components/ui/DropdownMenu.vue';

it('Escape closes the menu and restores focus without running the page shortcut', async () => {
	const pageShortcut = vi.fn();
	window.addEventListener('keydown', pageShortcut);
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
		const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		document.querySelector('[role="menuitem"]')!.dispatchEvent(escape);
		await nextTick();
		expect(escape.defaultPrevented).toBe(true);
		expect(pageShortcut).not.toHaveBeenCalled();
		expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false]);
		await wrapper.setProps({ open: false });
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(wrapper.get('button').element);
	} finally {
		wrapper.unmount();
		window.removeEventListener('keydown', pageShortcut);
	}
});
