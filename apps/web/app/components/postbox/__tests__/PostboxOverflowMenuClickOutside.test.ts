// @vitest-environment happy-dom
/**
 * PostboxOverflowMenu + the REAL useClickOutside.
 *
 * The sibling PostboxOverflowMenu.test.ts stubs the composable to capture the
 * handler, so it cannot see how the handler behaves against real DOM refs. That
 * blind spot hid a regression: the trigger became a component (<UiButton>), so
 * `triggerEl` holds a component instance, and the composable's
 * `t.value?.contains(node)` blew up on every document click — the panel could
 * never be dismissed by clicking away.
 *
 * These tests mount into document.body and dispatch genuine click events.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';

import { useClickOutside } from '~/composables/useClickOutside';
import PostboxOverflowMenu from '../PostboxOverflowMenu.vue';

// The component auto-imports the composable; give it the real one.
beforeAll(() => {
	Object.assign(globalThis, { useClickOutside });
});

const iconStub = { props: ['name'], template: '<span />' };

let wrapper: VueWrapper | null = null;
let outside: HTMLElement | null = null;

function mountMenu(): VueWrapper {
	outside = document.createElement('div');
	outside.className = 'page-outside';
	document.body.appendChild(outside);
	wrapper = mount(PostboxOverflowMenu, {
		attachTo: document.body,
		props: { label: 'More message actions' },
		slots: {
			default: `<template #default="{ close }">
				<button role="menuitem" class="demoted" @click="close">Reply all</button>
				<button role="menuitem" class="stay">Forward</button>
			</template>`,
		},
		global: { stubs: { Icon: iconStub } },
	});
	return wrapper;
}

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	outside?.remove();
	outside = null;
});

/** A real, bubbling click — the document listener only sees these. */
function clickOn(el: Element) {
	el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('PostboxOverflowMenu outside-click (unstubbed composable)', () => {
	it('closes when a click lands outside the trigger and the panel', async () => {
		const w = mountMenu();
		await w.get('button[aria-haspopup="menu"]').trigger('click');
		expect(w.find('[role="menu"]').exists()).toBe(true);

		clickOn(outside!);
		await w.vm.$nextTick();

		expect(w.find('[role="menu"]').exists()).toBe(false);
	});

	it('survives document clicks while closed (component-instance trigger ref)', async () => {
		const w = mountMenu();

		// Before the fix this threw "t.value?.contains is not a function" because
		// the UiButton ref is an instance, not an element.
		clickOn(outside!);
		await w.vm.$nextTick();

		// Still functional afterwards: the menu opens on the next trigger click.
		await w.get('button[aria-haspopup="menu"]').trigger('click');
		expect(w.find('[role="menu"]').exists()).toBe(true);
	});

	it('classifies the component trigger as inside, so opening is not undone', async () => {
		const w = mountMenu();

		// The opening click bubbles all the way to the document listener. If the
		// instance ref did not resolve to its root <button>, that listener would
		// treat the trigger as "outside" and close the panel in the same tick, so
		// the menu could never be opened at all.
		clickOn(w.get('button[aria-haspopup="menu"]').element);
		await w.vm.$nextTick();

		expect(w.find('[role="menu"]').exists()).toBe(true);
	});

	it('stays open when the click lands on a non-closing menu item', async () => {
		const w = mountMenu();
		await w.get('button[aria-haspopup="menu"]').trigger('click');

		clickOn(w.get('.stay').element);
		await w.vm.$nextTick();

		expect(w.find('[role="menu"]').exists()).toBe(true);
	});
});
