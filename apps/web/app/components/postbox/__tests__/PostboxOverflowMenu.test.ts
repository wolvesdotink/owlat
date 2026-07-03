// @vitest-environment happy-dom
/**
 * PostboxOverflowMenu behavior:
 *   - the trigger is an aria-labeled button that reports its expanded state
 *   - the menu panel is hidden until the trigger is clicked, then exposes the
 *     slotted items with role="menu" (keyboard/touch reachable)
 *   - Escape closes the panel
 *   - an outside click (via useClickOutside) closes the panel
 *   - the slot `close` helper dismisses the menu after an item runs
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxOverflowMenu from '../PostboxOverflowMenu.vue';

// Capture the outside-click handler so a test can invoke it directly.
let clickOutsideHandler: ((e: MouseEvent) => void) | null = null;
beforeAll(() => {
	vi.stubGlobal('useClickOutside', (_targets: unknown, handler: (e: MouseEvent) => void) => {
		clickOutsideHandler = handler;
	});
});

const iconStub = { props: ['name'], template: '<span />' };

function mountMenu() {
	return mount(PostboxOverflowMenu, {
		props: { label: 'More message actions' },
		slots: {
			default: `<template #default="{ close }">
				<button role="menuitem" class="demoted" @click="close">Reply all</button>
				<button role="menuitem">Forward</button>
			</template>`,
		},
		global: { stubs: { Icon: iconStub } },
	});
}

describe('PostboxOverflowMenu', () => {
	it('renders an aria-labeled, collapsed trigger', () => {
		const wrapper = mountMenu();
		const trigger = wrapper.get('button[aria-haspopup="menu"]');
		expect(trigger.attributes('aria-label')).toBe('More message actions');
		expect(trigger.attributes('aria-expanded')).toBe('false');
		expect(wrapper.find('[role="menu"]').exists()).toBe(false);
	});

	it('opens the menu with the demoted actions on click', async () => {
		const wrapper = mountMenu();
		await wrapper.get('button[aria-haspopup="menu"]').trigger('click');

		const menu = wrapper.get('[role="menu"]');
		expect(menu.attributes('aria-label')).toBe('More message actions');
		const items = menu.findAll('[role="menuitem"]');
		expect(items.map((i) => i.text())).toEqual(['Reply all', 'Forward']);
		expect(wrapper.get('button[aria-haspopup="menu"]').attributes('aria-expanded')).toBe('true');
	});

	it('closes on Escape', async () => {
		const wrapper = mountMenu();
		await wrapper.get('button[aria-haspopup="menu"]').trigger('click');
		expect(wrapper.find('[role="menu"]').exists()).toBe(true);

		await wrapper.get('[role="menu"]').trigger('keydown', { key: 'Escape' });
		expect(wrapper.find('[role="menu"]').exists()).toBe(false);
	});

	it('closes on an outside click', async () => {
		const wrapper = mountMenu();
		await wrapper.get('button[aria-haspopup="menu"]').trigger('click');
		expect(wrapper.find('[role="menu"]').exists()).toBe(true);

		clickOutsideHandler?.(new MouseEvent('click'));
		await wrapper.vm.$nextTick();
		expect(wrapper.find('[role="menu"]').exists()).toBe(false);
	});

	it('the slot close helper dismisses the menu after an item runs', async () => {
		const wrapper = mountMenu();
		await wrapper.get('button[aria-haspopup="menu"]').trigger('click');

		await wrapper.get('.demoted').trigger('click');
		expect(wrapper.find('[role="menu"]').exists()).toBe(false);
	});
});
