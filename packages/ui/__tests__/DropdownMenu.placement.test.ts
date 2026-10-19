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

/**
 * Where a browser reports a direct child of the menu: by default the children
 * share the menu's height, stacked. A test can report the boxes a browser
 * gives in a layout that summing children gets wrong.
 */
type ChildBox = (child: HTMLElement, menu: HTMLElement) => { top: number; height: number };
const stacked: ChildBox = (child, menu) => {
	const share = menuHeight / menu.children.length;
	return { top: Array.from(menu.children).indexOf(child) * share, height: share };
};
let childBox: ChildBox = stacked;

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
	// A laid-out box: a `max-height` caps the menu's border-box height, and, as
	// in a browser, lifting the cap leaves nothing to scroll, so the menu's
	// scroll position is lost. `menuHeight` is the height the browser would lay
	// the uncapped menu out at.
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		if (isMenu(this)) {
			const cap = Number.parseFloat(this.style.maxHeight);
			if (Number.isNaN(cap)) this.scrollTop = 0;
			return Number.isNaN(cap) ? menuHeight : Math.min(menuHeight, cap);
		}
		const parent = this.parentElement;
		return parent && isMenu(parent) ? childBox(this, parent).height : 0;
	});
	vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		const parent = this.parentElement;
		return parent && isMenu(parent) ? childBox(this, parent).top : 0;
	});
	vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		return isMenu(this) ? MENU_WIDTH : 0;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	childBox = stacked;
	scrollY = 0;
	viewport = { width: 1280, height: 720 };
});

const itemsHtml = (count: number) =>
	Array.from({ length: count }, (_, i) => `<button role="menuitem">Action ${i + 1}</button>`).join(
		''
	);

async function openMenu(position: 'left' | 'right', items: number | string = 1) {
	const wrapper = mount(DropdownMenu, {
		attachTo: document.body,
		props: { position },
		slots: {
			trigger: '<button id="menu-trigger">More actions</button>',
			default: typeof items === 'number' ? itemsHtml(items) : items,
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

	it('keeps where a capped menu was scrolled to, and does not move it for that scroll', async () => {
		trigger = { top: 100, left: 600 };
		menuHeight = 1000;
		const { wrapper, menu } = await openMenu('right', 20);
		try {
			const placed = menu.getAttribute('style');
			expect(menu.classList.contains('overflow-y-auto')).toBe(true);
			// The trigger has moved; a scroll inside the menu must not re-place it.
			trigger = { top: 300, left: 600 };
			menu.scrollTop = 100;
			menu.dispatchEvent(new Event('scroll'));
			await nextTick();
			expect(menu.scrollTop).toBe(100);
			expect(menu.getAttribute('style')).toBe(placed);
			// A scroll anywhere else still does.
			document.dispatchEvent(new Event('scroll'));
			await nextTick();
			expect(menu.style.top).toBe(`${300 + TRIGGER + 4}px`);
			expect(menu.scrollTop).toBe(100);
		} finally {
			wrapper.unmount();
		}
	});

	it('keeps the keyboard-focused last item of a capped menu in view', async () => {
		const observers: Array<() => void> = [];
		const original = globalThis.ResizeObserver;
		globalThis.ResizeObserver = class {
			constructor(callback: () => void) {
				observers.push(callback);
			}
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
		trigger = { top: 100, left: 600 };
		menuHeight = 1000;
		const { wrapper, menu } = await openMenu('right', 20);
		try {
			const items = menu.querySelectorAll<HTMLElement>('[role="menuitem"]');
			// The browser scrolls the menu to the item it focuses.
			items[19]!.addEventListener('focus', () => {
				menu.scrollTop = 1000 - 576;
				menu.dispatchEvent(new Event('scroll'));
			});
			items[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
			await nextTick();
			expect(document.activeElement).toBe(items[19]);
			// Measuring again (a resize, a page scroll) leaves the menu where it is.
			for (const callback of observers) callback();
			window.dispatchEvent(new Event('resize'));
			document.dispatchEvent(new Event('scroll'));
			await nextTick();
			expect(menu.scrollTop).toBe(1000 - 576);
			expect(menu.style.maxHeight).toBe('576px');
		} finally {
			wrapper.unmount();
			globalThis.ResizeObserver = original;
		}
	});

	describe('measures the menu as laid out, not by adding up its children', () => {
		it('counts items inside a display: contents wrapper', async () => {
			// Twenty 50 px items and 10 px of padding: 1010 px. The wrapper itself
			// has no box, so a browser reports it at 0 px.
			childBox = () => ({ top: 0, height: 0 });
			trigger = { top: 100, left: 600 };
			menuHeight = 1010;
			const { wrapper, menu } = await openMenu(
				'right',
				`<div style="display: contents">${itemsHtml(20)}</div>`
			);
			try {
				expect(menu.style.top).toBe('136px');
				expect(menu.style.maxHeight).toBe('576px');
				expect(menu.classList.contains('overflow-y-auto')).toBe(true);
				expectInsideWindow(layout(menu));
			} finally {
				wrapper.unmount();
			}
		});

		it('ignores the margin of a hidden child', async () => {
			// A 60 px menu with 76 px of room below the trigger stays below, however
			// large the margin of a child that is not displayed.
			childBox = (child) =>
				child.style.display === 'none' ? { top: 0, height: 0 } : { top: 0, height: 60 };
			trigger = { top: 720 - 8 - 76 - 4 - TRIGGER, left: 600 };
			menuHeight = 60;
			const { wrapper, menu } = await openMenu(
				'right',
				`${itemsHtml(1)}<div style="display: none; margin-bottom: 80px"></div>`
			);
			try {
				expect(menu.style.top).toBe(`${720 - 8 - 76}px`);
				expect(menu.style.bottom).toBe('');
				expect(menu.classList.contains('overflow-y-auto')).toBe(false);
			} finally {
				wrapper.unmount();
			}
		});

		it('counts the margins between items', async () => {
			// Four 60 px items fit the 290 px below; with their 15 px margins the
			// menu is 300 px, so it opens above.
			childBox = (child, menu) => ({
				top: Array.from(menu.children).indexOf(child) * 75,
				height: 60,
			});
			trigger = { top: 720 - 8 - 290 - 4 - TRIGGER, left: 600 };
			menuHeight = 300;
			const { wrapper, menu } = await openMenu(
				'right',
				Array.from(
					{ length: 4 },
					(_, i) => `<button role="menuitem" style="margin-bottom: 15px">Action ${i + 1}</button>`
				).join('')
			);
			try {
				expect(menu.style.top).toBe('');
				expect(menu.style.bottom).toBe(`${8 + 290 + 4 + TRIGGER + 4}px`);
				expect(menu.classList.contains('overflow-y-auto')).toBe(false);
				expectInsideWindow(layout(menu));
			} finally {
				wrapper.unmount();
			}
		});

		it('measures a copy, leaving nothing behind in the page', async () => {
			trigger = { top: 100, left: 600 };
			menuHeight = 300;
			const { wrapper } = await openMenu('right', 3);
			try {
				expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
			} finally {
				wrapper.unmount();
			}
		});
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
