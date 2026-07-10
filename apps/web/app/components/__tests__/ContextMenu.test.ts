// @vitest-environment happy-dom
/**
 * The shared right-click primitive (packages/ui ContextMenu.vue):
 *   - opens on a `contextmenu` event (mouse right-click)
 *   - opens on the keyboard context-menu key (keydown)
 *   - selecting an item runs the item's `run` closure — the SAME action source
 *     the row's visible controls invoke — and closes the menu
 *   - focuses the first item on open (focus trap entry)
 *   - closes on Escape
 *   - degrades gracefully: with no enabled items it never opens, so the native
 *     browser menu shows through
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';

import UiContextMenu, { type ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';

const Icon = defineComponent({ name: 'Icon', props: ['name'], template: '<i />' });

function makeHarness(items: ContextMenuItem[]) {
	return defineComponent({
		components: { UiContextMenu },
		setup() {
			return { items };
		},
		template: `
			<UiContextMenu :items="items" v-slot="{ onContextmenu, onKeydown }">
				<button class="trigger" @contextmenu="onContextmenu" @keydown="onKeydown">row</button>
			</UiContextMenu>
		`,
	});
}

function mountHarness(items: ContextMenuItem[]) {
	return mount(makeHarness(items), {
		attachTo: document.body,
		global: { components: { Icon } },
	});
}

const menuEl = () => document.body.querySelector<HTMLElement>('[role="menu"]');
const menuItems = () =>
	Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));

async function waitForClose() {
	await new Promise((resolve) => setTimeout(resolve, 60));
}

describe('UiContextMenu', () => {
	it('opens on a contextmenu event and renders the items', async () => {
		const ran: string[] = [];
		const items: ContextMenuItem[] = [
			{ id: 'archive', label: 'Archive', run: () => ran.push('archive') },
			{ id: 'delete', label: 'Delete', danger: true, run: () => ran.push('delete') },
		];
		const wrapper = mountHarness(items);

		expect(menuEl()).toBeNull();
		await wrapper.find('.trigger').trigger('contextmenu', { clientX: 20, clientY: 30 });

		expect(menuEl()).not.toBeNull();
		expect(menuItems().map((el) => el.textContent?.trim())).toEqual(['Archive', 'Delete']);
		wrapper.unmount();
	});

	it('opens via the keyboard context-menu key', async () => {
		const items: ContextMenuItem[] = [{ id: 'archive', label: 'Archive', run: () => {} }];
		const wrapper = mountHarness(items);

		await wrapper.find('.trigger').trigger('keydown', { key: 'ContextMenu' });

		expect(menuEl()).not.toBeNull();
		expect(menuItems()).toHaveLength(1);
		wrapper.unmount();
	});

	it('runs the selected item action and then closes', async () => {
		const run = vi.fn();
		const items: ContextMenuItem[] = [{ id: 'archive', label: 'Archive', run }];
		const wrapper = mountHarness(items);

		await wrapper.find('.trigger').trigger('contextmenu', { clientX: 5, clientY: 5 });
		menuItems()[0]?.click();

		expect(run).toHaveBeenCalledTimes(1);
		await waitForClose();
		expect(menuEl()).toBeNull();
		wrapper.unmount();
	});

	it('focuses the first item when opened (focus-trap entry)', async () => {
		const items: ContextMenuItem[] = [
			{ id: 'archive', label: 'Archive', run: () => {} },
			{ id: 'delete', label: 'Delete', run: () => {} },
		];
		const wrapper = mountHarness(items);

		await wrapper.find('.trigger').trigger('contextmenu', { clientX: 5, clientY: 5 });
		// useModalFocus moves focus in after an internal nextTick.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(document.activeElement).toBe(menuItems()[0]);
		wrapper.unmount();
	});

	it('closes on Escape', async () => {
		const items: ContextMenuItem[] = [{ id: 'archive', label: 'Archive', run: () => {} }];
		const wrapper = mountHarness(items);

		await wrapper.find('.trigger').trigger('contextmenu', { clientX: 5, clientY: 5 });
		expect(menuEl()).not.toBeNull();

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await waitForClose();

		expect(menuEl()).toBeNull();
		wrapper.unmount();
	});

	it('never opens (native menu shows through) when there are no enabled items', async () => {
		const items: ContextMenuItem[] = [
			{ id: 'archive', label: 'Archive', disabled: true, run: () => {} },
		];
		const wrapper = mountHarness(items);

		await wrapper.find('.trigger').trigger('contextmenu', { clientX: 5, clientY: 5 });

		expect(menuEl()).toBeNull();
		wrapper.unmount();
	});
});
