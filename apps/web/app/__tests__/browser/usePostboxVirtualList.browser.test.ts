/**
 * The Postbox thread list's window under real scrolling, resizing and layout.
 *
 * The unit suite proves the range math with numbers it makes up; here the
 * numbers come from Chrome: `scrollTop` from a native scroll, `clientHeight`
 * from a ResizeObserver that actually fires, and the list's offset inside an
 * outer scroller from `getBoundingClientRect`. Every assertion is about what
 * the browser shows: which rows exist, and where they sit on screen.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { usePostboxVirtualList } from '~/composables/postbox/usePostboxVirtualList';
import { nextResize, scrollTo } from './events';

const ROW = 40;
const OVERSCAN = 2;

function mountList(options: { count: number; height: number; header?: number }) {
	const height = ref(options.height);
	let api!: ReturnType<typeof usePostboxVirtualList>;
	const Harness = defineComponent({
		setup() {
			const scrollEl = ref<HTMLElement | null>(null);
			const listEl = ref<HTMLElement | null>(null);
			api = usePostboxVirtualList({
				scrollEl,
				listEl: options.header ? listEl : undefined,
				itemCount: ref(options.count),
				rowHeight: ref(ROW),
				enabled: ref(true),
				overscan: OVERSCAN,
			});
			return () => {
				const { startIndex, endIndex, offsetY, totalHeight } = api.range.value;
				const rows = [];
				for (let i = startIndex; i < endIndex; i++)
					rows.push(h('div', { key: i, 'data-row': i, style: { height: `${ROW}px` } }, `Row ${i}`));
				return h(
					'div',
					{
						ref: scrollEl,
						'data-testid': 'scroller',
						style: { height: `${height.value}px`, overflowY: 'auto' },
						onScroll: api.syncScroll,
					},
					[
						options.header ? h('div', { style: { height: `${options.header}px` } }) : null,
						h('div', { ref: listEl, style: { height: `${totalHeight}px` } }, [
							h('div', { style: { transform: `translateY(${offsetY}px)` } }, rows),
						]),
					]
				);
			};
		},
	});
	const wrapper = mount(Harness, { attachTo: document.body });
	const scroller = wrapper.get<HTMLElement>('[data-testid="scroller"]').element;

	/** Indices of the rows in the DOM, in order. */
	const mounted = () =>
		[...scroller.querySelectorAll<HTMLElement>('[data-row]')].map((el) =>
			Number(el.dataset['row'])
		);
	/** Where row `index` sits relative to the scroller's top edge, as painted. */
	const rowTop = (index: number) =>
		scroller.querySelector(`[data-row="${index}"]`)!.getBoundingClientRect().top -
		scroller.getBoundingClientRect().top;
	/** The rows the scroller's viewport actually shows, from layout. */
	const visible = () => {
		const box = scroller.getBoundingClientRect();
		return [...scroller.querySelectorAll<HTMLElement>('[data-row]')]
			.filter((el) => {
				const rect = el.getBoundingClientRect();
				return rect.bottom > box.top && rect.top < box.bottom;
			})
			.map((el) => Number(el.dataset['row']));
	};
	return { api, height, scroller, mounted, rowTop, visible };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe('usePostboxVirtualList in a real browser', () => {
	it('mounts only the rows around the viewport, each where the full list would put it', async () => {
		const list = mountList({ count: 1000, height: 400 });
		await nextTick();

		// 10 visible rows, one partial-row allowance, the overscan below.
		expect(list.mounted()).toEqual(range(0, 13));
		expect(list.visible()).toEqual(range(0, 10));
		expect(list.rowTop(0)).toBe(0);
		expect(list.scroller.scrollHeight).toBe(1000 * ROW);
	});

	it('moves the window with a native scroll', async () => {
		const list = mountList({ count: 1000, height: 400 });
		await nextTick();

		await scrollTo(list.scroller, 100 * ROW);
		await nextTick();

		expect(list.mounted()).toEqual(range(100 - OVERSCAN, 113));
		expect(list.visible()).toEqual(range(100, 110));
		expect(list.rowTop(100)).toBe(0);
	});

	it('widens the window when the scroller grows', async () => {
		const list = mountList({ count: 1000, height: 400 });
		await nextTick();

		list.height.value = 800;
		await nextTick();
		await nextResize(list.scroller);
		await nextTick();

		expect(list.api.viewportHeight.value).toBe(800);
		expect(list.visible()).toEqual(range(0, 20));
		expect(list.mounted()).toEqual(range(0, 23));
	});

	it('reveals an unmounted row with nearest semantics', async () => {
		const list = mountList({ count: 1000, height: 400 });
		await nextTick();

		// Below the viewport: the row ends up flush with the bottom edge.
		list.api.scrollToIndex(500);
		await nextTick();
		expect(list.scroller.scrollTop).toBe(501 * ROW - 400);
		expect(list.rowTop(500)).toBe(400 - ROW);
		expect(list.visible()).toEqual(range(491, 501));

		// Above it: the row ends up flush with the top edge.
		list.api.scrollToIndex(480);
		await nextTick();
		expect(list.rowTop(480)).toBe(0);
		expect(list.visible()).toEqual(range(480, 490));

		// Already in view: nothing moves.
		const before = list.scroller.scrollTop;
		list.api.scrollToIndex(485);
		await nextTick();
		expect(list.scroller.scrollTop).toBe(before);
		expect(list.mounted().length).toBeLessThanOrEqual(10 + 2 * OVERSCAN + 1);
	});

	it('windows against an outer scroller, measuring the content above the list', async () => {
		const list = mountList({ count: 1000, height: 400, header: 300 });
		await nextTick();

		// The header fills most of the viewport: only the first rows show.
		expect(list.visible()).toEqual(range(0, 3));

		await scrollTo(list.scroller, 300 + 50 * ROW);
		await nextTick();

		expect(list.visible()).toEqual(range(50, 60));
		expect(list.rowTop(50)).toBe(0);
		expect(list.mounted()).toEqual(range(50 - OVERSCAN, 63));
	});
});
