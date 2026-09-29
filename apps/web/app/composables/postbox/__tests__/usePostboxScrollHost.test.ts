// @vitest-environment happy-dom
/**
 * Windowing a list against a scroller it does not own (the Today column, the
 * page itself): the offset of the list inside that scroller, the scroller
 * lookup, event binding, and the window + focus-follow math through
 * usePostboxVirtualList's `listEl` mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, shallowRef, type Ref } from 'vue';
import {
	findScrollParent,
	isDocumentScroller,
	measureListOffset,
	usePostboxScrollEvent,
} from '../usePostboxScrollHost';
import { usePostboxVirtualList } from '../usePostboxVirtualList';
import { usePostboxHostedVirtualList } from '../usePostboxHostedVirtualList';

const ROW = 50;

/** A scroller whose geometry the test drives (happy-dom does no layout). */
function fakeScroller(opts: { top: number; clientHeight: number }) {
	const el = document.createElement('div');
	let scrollTop = 0;
	Object.defineProperty(el, 'scrollTop', {
		configurable: true,
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = v;
		},
	});
	Object.defineProperty(el, 'clientHeight', { configurable: true, value: opts.clientHeight });
	el.getBoundingClientRect = () => ({ top: opts.top }) as DOMRect;
	return el;
}

/** A list that starts `offset` px into `scroller`'s content. */
function fakeList(scroller: HTMLElement, hostTop: number, offset: number) {
	const el = document.createElement('ul');
	el.getBoundingClientRect = () => ({ top: hostTop + offset - scroller.scrollTop }) as DOMRect;
	return el;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('measureListOffset', () => {
	it('is the scrollTop at which the list reaches the scroller top, however far it is scrolled', () => {
		const scroller = fakeScroller({ top: 40, clientHeight: 300 });
		const list = fakeList(scroller, 40, 600);
		expect(measureListOffset(scroller, list)).toBe(600);
		scroller.scrollTop = 450;
		expect(measureListOffset(scroller, list)).toBe(600);
	});

	it('measures against the viewport when the document scrolls', () => {
		const doc = document.scrollingElement as HTMLElement;
		const list = document.createElement('ul');
		list.getBoundingClientRect = () => ({ top: 120 }) as DOMRect;
		expect(isDocumentScroller(doc)).toBe(true);
		expect(measureListOffset(doc, list)).toBe(120 + doc.scrollTop);
	});
});

describe('findScrollParent', () => {
	it('finds the nearest ancestor that scrolls vertically', () => {
		const outer = document.createElement('div');
		outer.style.overflowY = 'auto';
		const middle = document.createElement('div');
		const list = document.createElement('ul');
		middle.append(list);
		outer.append(middle);
		document.body.append(outer);
		expect(findScrollParent(list)).toBe(outer);
	});

	it('falls back to the document scroller when nothing in between scrolls', () => {
		const list = document.createElement('ul');
		document.body.append(list);
		expect(findScrollParent(list)).toBe(document.scrollingElement);
	});
});

describe('usePostboxScrollEvent', () => {
	function mountBinder(target: Ref<HTMLElement | null>, handler: () => void) {
		return mount(
			defineComponent({
				setup() {
					usePostboxScrollEvent(target, handler);
					return () => h('div');
				},
			})
		);
	}

	it('listens on the element, re-binds when it changes and unbinds on unmount', async () => {
		const a = document.createElement('div');
		const b = document.createElement('div');
		const target = shallowRef<HTMLElement | null>(a);
		const handler = vi.fn();
		const w = mountBinder(target, handler);
		a.dispatchEvent(new Event('scroll'));
		expect(handler).toHaveBeenCalledTimes(1);

		target.value = b;
		await nextTick();
		a.dispatchEvent(new Event('scroll'));
		b.dispatchEvent(new Event('scroll'));
		expect(handler).toHaveBeenCalledTimes(2);

		w.unmount();
		b.dispatchEvent(new Event('scroll'));
		expect(handler).toHaveBeenCalledTimes(2);
	});

	it('listens on window when the document is the scroller (its scroll events fire there)', () => {
		const handler = vi.fn();
		const w = mountBinder(shallowRef(document.scrollingElement as HTMLElement), handler);
		window.dispatchEvent(new Event('scroll'));
		expect(handler).toHaveBeenCalledTimes(1);
		w.unmount();
	});
});

describe('usePostboxVirtualList against an outer scroller', () => {
	function mountWindow(scroller: HTMLElement, list: HTMLElement, itemCount = 1000) {
		let api!: ReturnType<typeof usePostboxVirtualList>;
		mount(
			defineComponent({
				setup() {
					api = usePostboxVirtualList({
						scrollEl: shallowRef(scroller),
						listEl: shallowRef(list),
						itemCount: ref(itemCount),
						rowHeight: ref(ROW),
						enabled: ref(true),
						overscan: 2,
					});
					return () => h('div');
				},
			})
		);
		return api;
	}

	it('windows from where the list starts, not from the scroller top', () => {
		const scroller = fakeScroller({ top: 0, clientHeight: 200 });
		const list = fakeList(scroller, 0, 600);
		const { range, syncScroll } = mountWindow(scroller, list);

		// Scrolled 400px: the list (600px down) is still below the fold, so the
		// window is its first rows, not rows 8+ a list-owned scroller would give.
		scroller.scrollTop = 400;
		syncScroll();
		expect(range.value.startIndex).toBe(0);

		// 600px into the list: rows 12..16 are visible, plus 2 rows of overscan.
		scroller.scrollTop = 1200;
		syncScroll();
		expect(range.value.startIndex).toBe(10);
		expect(range.value.endIndex).toBe(12 + 4 + 2 + 1);
		expect(range.value.offsetY).toBe(10 * ROW);
	});

	it('picks up a list that moved down (content above it grew) on the next scroll frame', () => {
		const scroller = fakeScroller({ top: 0, clientHeight: 200 });
		let offset = 600;
		const list = document.createElement('ul');
		list.getBoundingClientRect = () => ({ top: offset - scroller.scrollTop }) as DOMRect;
		const { range, syncScroll } = mountWindow(scroller, list);
		scroller.scrollTop = 1200;
		syncScroll();
		expect(range.value.startIndex).toBe(10);
		offset = 800;
		syncScroll();
		expect(range.value.startIndex).toBe(6);
	});

	it('reveals a focused row at its place in the scroller, offset included', () => {
		const scroller = fakeScroller({ top: 0, clientHeight: 200 });
		const list = fakeList(scroller, 0, 600);
		const { scrollToIndex } = mountWindow(scroller, list);
		// Row 20 spans 600+1000..600+1050 in scroller content.
		scrollToIndex(20);
		expect(scroller.scrollTop).toBe(600 + 21 * ROW - 200);
	});
});

describe('usePostboxHostedVirtualList', () => {
	it('finds the scroller the list mounts in and follows its scroll', async () => {
		const scroller = fakeScroller({ top: 0, clientHeight: 200 });
		scroller.style.overflowY = 'auto';
		document.body.append(scroller);
		let api!: ReturnType<typeof usePostboxHostedVirtualList>;
		const listEl = shallowRef<HTMLElement | null>(null);
		mount(
			defineComponent({
				setup() {
					api = usePostboxHostedVirtualList({
						listEl,
						itemCount: ref(1000),
						rowHeight: ref(ROW),
						enabled: ref(true),
						overscan: 0,
					});
					return () => h('ul', { ref: listEl });
				},
			}),
			{ attachTo: scroller }
		);
		await nextTick();
		expect(api.scrollHost.value).toBe(scroller);
		const list = listEl.value!;
		list.getBoundingClientRect = () => ({ top: 100 - scroller.scrollTop }) as DOMRect;

		scroller.scrollTop = 100 + 40 * ROW;
		scroller.dispatchEvent(new Event('scroll'));
		await vi.waitFor(() => expect(api.range.value.startIndex).toBe(40));
	});
});
