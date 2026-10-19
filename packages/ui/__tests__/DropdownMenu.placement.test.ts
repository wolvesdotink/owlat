/**
 * Where the open menu lands. It is fixed to the trigger's box in viewport
 * coordinates, measured once it has rendered and whenever its size changes:
 * below when it fits, flipped above when there is more room there, capped (and
 * scrolling inside) when it fits on neither side, and kept 8 px inside the
 * window on every edge, whichever corner the trigger sits in and however far
 * the page has scrolled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DropdownMenu from '../components/ui/DropdownMenu.vue';

const MARGIN = 8;
const TRIGGER = 32;
const MENU_WIDTH = 176;

interface Box {
	top: number;
	left: number;
}

let viewport = { width: 1280, height: 720 };
let trigger: Box = { top: 0, left: 0 };
let menuHeight = 0;
let scrollY = 0;

const rect = ({ top, left }: Box, width: number, height: number) =>
	({
		top,
		left,
		bottom: top + height,
		right: left + width,
		width,
		height,
		x: left,
		y: top,
		toJSON: () => ({}),
	}) as DOMRect;

const isMenu = (el: Element) => el.getAttribute('role') === 'menu';

beforeEach(() => {
	vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => viewport.width);
	vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => viewport.height);
	vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
		this: HTMLElement
	) {
		return this.querySelector('#menu-trigger')
			? rect(trigger, TRIGGER, TRIGGER)
			: rect({ top: 0, left: 0 }, 0, 0);
	});
	// A laid-out box: a `max-height` caps the menu's border-box height.
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		if (!isMenu(this)) return 0;
		const cap = Number.parseFloat(this.style.maxHeight);
		return Number.isNaN(cap) ? menuHeight : Math.min(menuHeight, cap);
	});
	vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		return isMenu(this) ? MENU_WIDTH : 0;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	scrollY = 0;
	viewport = { width: 1280, height: 720 };
});

async function openMenu(position: 'left' | 'right') {
	const wrapper = mount(DropdownMenu, {
		attachTo: document.body,
		props: { position },
		slots: {
			trigger: '<button id="menu-trigger">More actions</button>',
			default: '<button role="menuitem">Duplicate</button>',
		},
	});
	await wrapper.setProps({ open: true });
	await nextTick();
	await nextTick();
	const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
	return { wrapper, menu };
}

/** The menu's box as the browser would lay it out from its inline style. */
function layout(menu: HTMLElement) {
	// No cap at all: the whole menu shows, however tall.
	const maxHeight = menu.style.maxHeight ? Number.parseFloat(menu.style.maxHeight) : Infinity;
	const height = Math.min(menuHeight, maxHeight);
	const top = menu.style.top
		? Number.parseFloat(menu.style.top)
		: viewport.height - Number.parseFloat(menu.style.bottom) - height;
	const left = Number.parseFloat(menu.style.left);
	return { top, bottom: top + height, left, right: left + MENU_WIDTH, maxHeight };
}

function expectInsideWindow(box: ReturnType<typeof layout>) {
	expect(box.top).toBeGreaterThanOrEqual(MARGIN);
	expect(box.bottom).toBeLessThanOrEqual(viewport.height - MARGIN);
	expect(box.left).toBeGreaterThanOrEqual(MARGIN);
	expect(box.right).toBeLessThanOrEqual(viewport.width - MARGIN);
}

const corners: Record<string, Box> = {
	'top-left': { top: 0, left: 0 },
	'top-right': { top: 0, left: 1280 - TRIGGER },
	'bottom-left': { top: 720 - TRIGGER, left: 0 },
	'bottom-right': { top: 720 - TRIGGER, left: 1280 - TRIGGER },
	middle: { top: 344, left: 624 },
};

describe('DropdownMenu placement', () => {
	for (const [corner, box] of Object.entries(corners)) {
		for (const position of ['left', 'right'] as const) {
			for (const height of [120, 300, 1000]) {
				it(`stays inside the window: ${corner}, position ${position}, ${height} px menu`, async () => {
					trigger = box;
					menuHeight = height;
					const { wrapper, menu } = await openMenu(position);
					try {
						expectInsideWindow(layout(menu));
					} finally {
						wrapper.unmount();
					}
				});
			}
		}
	}

	it('opens under the trigger, lined up with its right edge, when it fits', async () => {
		trigger = { top: 100, left: 600 };
		menuHeight = 300;
		const { wrapper, menu } = await openMenu('right');
		try {
			expect(menu.style.top).toBe('136px');
			expect(menu.style.bottom).toBe('');
			expect(menu.style.left).toBe(`${600 + TRIGGER - MENU_WIDTH}px`);
			expect(menu.style.transformOrigin).toBe('top');
			// A menu that fits is no scroll box (that would clip its items' focus outline).
			expect(menu.classList.contains('overflow-y-auto')).toBe(false);
		} finally {
			wrapper.unmount();
		}
	});

	it('flips above a trigger near the bottom-right corner, measuring the menu instead of guessing', async () => {
		// 230 px below the trigger: over the old 200 px estimate, short of a 300 px menu.
		trigger = { top: 720 - 230 - TRIGGER, left: 1280 - TRIGGER - 16 };
		menuHeight = 300;
		const { wrapper, menu } = await openMenu('right');
		try {
			expect(menu.style.top).toBe('');
			expect(menu.style.bottom).toBe(`${230 + TRIGGER + 4}px`);
			expect(menu.style.transformOrigin).toBe('bottom');
			expectInsideWindow(layout(menu));
		} finally {
			wrapper.unmount();
		}
	});

	it('ignores how far the page has scrolled: fixed coordinates are viewport coordinates', async () => {
		trigger = { top: 200, left: 600 };
		menuHeight = 300;
		const unscrolled = await openMenu('right');
		const expected = unscrolled.menu.getAttribute('style');
		unscrolled.wrapper.unmount();

		scrollY = 1500;
		const { wrapper, menu } = await openMenu('right');
		try {
			expect(menu.getAttribute('style')).toBe(expected);
			expect(menu.style.top).toBe(`${200 + TRIGGER + 4}px`);
			expectInsideWindow(layout(menu));
		} finally {
			wrapper.unmount();
		}
	});

	it('caps a long menu to the room it has and lets it scroll inside', async () => {
		trigger = { top: 100, left: 600 };
		menuHeight = 1000;
		const { wrapper, menu } = await openMenu('left');
		try {
			// Below has more room (720 - 136 - 8) than above.
			expect(menu.style.top).toBe('136px');
			expect(menu.style.maxHeight).toBe('576px');
			expect(menu.classList.contains('overflow-y-auto')).toBe(true);
		} finally {
			wrapper.unmount();
		}
	});

	it('measures the whole menu, not the height an earlier placement capped it to', async () => {
		// Placed first with no height (below, capped to 76 px of room), then
		// measured: the 199 px menu must flip above, not read the stale cap back.
		viewport = { width: 1280, height: 300 };
		trigger = { top: 180, left: 600 };
		menuHeight = 199;
		const { wrapper, menu } = await openMenu('right');
		try {
			expect(menu.style.top).toBe('');
			expect(menu.style.bottom).toBe(`${300 - 180 + 4}px`);
			// 168 px of room above: capped there, scrolling inside.
			expect(menu.style.maxHeight).toBe('168px');
			expect(menu.classList.contains('overflow-y-auto')).toBe(true);
			expectInsideWindow(layout(menu));
		} finally {
			wrapper.unmount();
		}
	});

	it('places the menu again when its content grows while open', async () => {
		const observers: Array<() => void> = [];
		// Swapped by hand: vi.unstubAllGlobals() would also drop the setup file's
		// auto-import globals.
		const original = globalThis.ResizeObserver;
		globalThis.ResizeObserver = class {
			constructor(callback: () => void) {
				observers.push(callback);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
		trigger = { top: 400, left: 600 };
		menuHeight = 120;
		const { wrapper, menu } = await openMenu('right');
		try {
			expect(menu.style.top).toBe(`${400 + TRIGGER + 4}px`);
			// Late items: now taller than the room below.
			menuHeight = 400;
			for (const callback of observers) callback();
			await nextTick();
			expect(menu.style.top).toBe('');
			expectInsideWindow(layout(menu));
		} finally {
			wrapper.unmount();
			globalThis.ResizeObserver = original;
		}
	});

	it('places the menu again when the window resizes', async () => {
		trigger = { top: 100, left: 600 };
		menuHeight = 300;
		const { wrapper, menu } = await openMenu('right');
		try {
			viewport = { width: 1280, height: 420 };
			trigger = { top: 360, left: 600 };
			window.dispatchEvent(new Event('resize'));
			await nextTick();
			expect(menu.style.top).toBe('');
			expectInsideWindow(layout(menu));
		} finally {
			wrapper.unmount();
		}
	});
});
