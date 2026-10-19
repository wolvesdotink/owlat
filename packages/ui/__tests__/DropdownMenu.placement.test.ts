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
/** The menu's content wrapper, which is never capped. */
const isContent = (el: Element) => !!el.parentElement && isMenu(el.parentElement);

/**
 * ResizeObserver, faked: `resize(el)` runs the callbacks of the observers
 * watching `el`, as a browser would when that box changed size.
 */
let observed: Array<{ callback: () => void; targets: Set<Element> }> = [];
const originalResizeObserver = globalThis.ResizeObserver;
function resize(el: Element) {
	for (const { callback, targets } of observed) if (targets.has(el)) callback();
}

beforeEach(() => {
	observed = [];
	// Swapped by hand: vi.unstubAllGlobals() would also drop the setup file's
	// auto-import globals.
	globalThis.ResizeObserver = class {
		private entry: { callback: () => void; targets: Set<Element> };
		constructor(callback: () => void) {
			this.entry = { callback, targets: new Set() };
			observed.push(this.entry);
		}
		observe(el: Element) {
			this.entry.targets.add(el);
		}
		unobserve(el: Element) {
			this.entry.targets.delete(el);
		}
		disconnect() {
			this.entry.targets.clear();
		}
	} as unknown as typeof ResizeObserver;
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
	// A laid-out box. `menuHeight` is the menu's natural height (no padding or
	// border here, so it is all content): its uncapped content box is that tall,
	// and a `max-height` caps the menu itself. As in a browser, lifting the
	// menu's cap leaves nothing to scroll, so its scroll position is lost.
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		if (isMenu(this)) {
			const cap = Number.parseFloat(this.style.maxHeight);
			if (Number.isNaN(cap)) this.scrollTop = 0;
			return Number.isNaN(cap) ? menuHeight : Math.min(menuHeight, cap);
		}
		return isContent(this) ? menuHeight : 0;
	});
	vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
		this: HTMLElement
	) {
		return isMenu(this) ? MENU_WIDTH : 0;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.ResizeObserver = originalResizeObserver;
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
		trigger = { top: 400, left: 600 };
		menuHeight = 120;
		const { wrapper, menu } = await openMenu('right');
		try {
			expect(menu.style.top).toBe(`${400 + TRIGGER + 4}px`);
			// Late items: now taller than the room below.
			menuHeight = 400;
			resize(menu.firstElementChild!);
			await nextTick();
			expect(menu.style.top).toBe('');
			expectInsideWindow(layout(menu));
		} finally {
			wrapper.unmount();
		}
	});

	it('sees content grow once the menu already fills its room', async () => {
		// 210 px of room below and only 134 px above: a 210 px menu fills the room
		// exactly, so the menu's own box cannot grow any further. Only the content
		// inside it does.
		viewport = { width: 1280, height: 400 };
		trigger = { top: 400 - 8 - 210 - 4 - TRIGGER, left: 600 };
		menuHeight = 210;
		const { wrapper, menu } = await openMenu('right', 6);
		try {
			expect(menu.style.maxHeight).toBe('210px');
			expect(menu.classList.contains('overflow-y-auto')).toBe(false);
			menuHeight = 330;
			resize(menu.firstElementChild!);
			await nextTick();
			expect(menu.style.top).toBe(`${400 - 8 - 210}px`);
			expect(menu.style.maxHeight).toBe('210px');
			expect(menu.classList.contains('overflow-y-auto')).toBe(true);
		} finally {
			wrapper.unmount();
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
			resize(menu.firstElementChild!);
			window.dispatchEvent(new Event('resize'));
			document.dispatchEvent(new Event('scroll'));
			await nextTick();
			expect(menu.scrollTop).toBe(1000 - 576);
			expect(menu.style.maxHeight).toBe('576px');
		} finally {
			wrapper.unmount();
		}
	});

	describe('measures the menu as laid out', () => {
		it('counts items inside a display: contents wrapper', async () => {
			// Twenty 50 px items and 10 px of padding: 1010 px, laid out by the
			// browser inside the content box.
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

		it('adds the menu padding and border to its content', async () => {
			trigger = { top: 100, left: 600 };
			menuHeight = 300;
			const { wrapper, menu } = await openMenu('right', 3);
			try {
				// 300 px of content in a menu with 4 px padding and a 1 px border:
				// 310 px, more than the 300 px of room left after a resize.
				menu.style.padding = '4px 0';
				menu.style.border = '1px solid';
				viewport = { width: 1280, height: 444 };
				window.dispatchEvent(new Event('resize'));
				await nextTick();
				expect(menu.style.maxHeight).toBe('300px');
				expect(menu.classList.contains('overflow-y-auto')).toBe(true);
			} finally {
				wrapper.unmount();
			}
		});

		it('measures without adding anything to the page or changing the menu content', async () => {
			trigger = { top: 100, left: 600 };
			menuHeight = 300;
			const added: Node[] = [];
			const watcher = new MutationObserver((records) => {
				for (const record of records) added.push(...record.addedNodes);
			});
			const { wrapper, menu } = await openMenu(
				'right',
				`<input type="radio" name="sort" value="recent" checked><input type="radio" name="sort" value="priority">`
			);
			try {
				const [recent, priority] = menu.querySelectorAll<HTMLInputElement>('input');
				watcher.observe(document.body, { childList: true, subtree: true });
				resize(menu.firstElementChild!);
				window.dispatchEvent(new Event('resize'));
				document.dispatchEvent(new Event('scroll'));
				await nextTick();
				watcher.disconnect();
				expect(added.filter((node) => node.nodeType === Node.ELEMENT_NODE)).toEqual([]);
				expect(recent!.checked).toBe(true);
				expect(priority!.checked).toBe(false);
				expect(document.querySelectorAll('input[name="sort"]')).toHaveLength(2);
			} finally {
				watcher.disconnect();
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
