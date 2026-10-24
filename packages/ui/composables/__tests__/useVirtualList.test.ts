/**
 * `useVirtualList` against a scripted DOM: happy-dom has no layout, so the
 * scroller's geometry is computed from what the list rendered (spacer heights
 * plus each mounted row's "real" height), and ResizeObserver is a fake whose
 * callbacks the tests deliver by hand. Animation frames are queued and run on
 * demand, so nothing waits on a clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, type PropType, type Ref } from 'vue';
import { useVirtualList } from '../useVirtualList';

interface Item {
	id: string;
}

const VIEWPORT = 400;
const ESTIMATE = 50;

/** Real row heights by key; a row not listed is as tall as its estimate. */
let real: Map<string, number>;
const realHeight = (key: string) => real.get(key) ?? ESTIMATE;

// --- Fake ResizeObserver ------------------------------------------------------

class FakeResizeObserver {
	static instances: FakeResizeObserver[] = [];
	observed = new Set<Element>();
	boxes = new Map<Element, ResizeObserverBoxOptions>();
	disconnected = false;
	constructor(public callback: ResizeObserverCallback) {
		FakeResizeObserver.instances.push(this);
	}
	observe(el: Element, options?: ResizeObserverOptions) {
		this.observed.add(el);
		this.boxes.set(el, options?.box ?? 'content-box');
	}
	unobserve(el: Element) {
		this.observed.delete(el);
		this.boxes.delete(el);
	}
	disconnect() {
		this.disconnected = true;
		this.observed.clear();
		this.boxes.clear();
	}
	/**
	 * A change to the row's padding or border only: the browser notifies just
	 * the observers watching the border box.
	 */
	deliverPaddingChange(target: Element) {
		if (this.boxes.get(target) === 'border-box') this.deliver([target]);
	}
	/** Deliver one notification for `targets` with their current real heights. */
	deliver(targets: Element[]) {
		const entries = targets.map((target) => {
			const key = (target as HTMLElement).dataset['key'];
			const blockSize = key === undefined ? VIEWPORT : realHeight(key);
			return {
				target,
				borderBoxSize: [{ blockSize, inlineSize: 0 }],
			} as unknown as ResizeObserverEntry;
		});
		this.callback(entries, this as unknown as ResizeObserver);
	}
	/** Every observed row, as the browser reports newly observed elements. */
	deliverRows() {
		this.deliver([...this.observed].filter((el) => (el as HTMLElement).dataset['key']));
	}
}
const observer = () => FakeResizeObserver.instances.at(-1)!;

// --- Animation frames -------------------------------------------------------

let frames: FrameRequestCallback[] = [];
async function runFrame() {
	const queued = frames;
	frames = [];
	for (const callback of queued) callback(0);
	await nextTick();
}

// --- Scroller geometry ------------------------------------------------------

const scrollTops = new WeakMap<Element, number>();
const scrollTo = vi.fn();

function contentHeight(el: HTMLElement): number {
	let height = 0;
	for (const child of Array.from(el.children) as HTMLElement[]) {
		height += parseFloat(child.style.height || '0') + parseFloat(child.style.marginTop || '0');
		if (child.dataset['key']) height += realHeight(child.dataset['key']);
	}
	return height;
}
const isScroller = (el: Element) => (el as HTMLElement).dataset?.['scroller'] === 'true';
const maxScroll = (el: HTMLElement) => Math.max(0, contentHeight(el) - VIEWPORT);

const descriptors = {
	scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'),
	clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
	scrollTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop'),
	scrollTo: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo'),
};

function installGeometry() {
	Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
		configurable: true,
		get(this: HTMLElement) {
			return isScroller(this) ? contentHeight(this) : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get(this: HTMLElement) {
			return isScroller(this) ? VIEWPORT : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
		configurable: true,
		get(this: HTMLElement) {
			return scrollTops.get(this) ?? 0;
		},
		set(this: HTMLElement, value: number) {
			const max = isScroller(this) ? maxScroll(this) : 0;
			scrollTops.set(this, Math.min(Math.max(0, value), max));
		},
	});
	Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
		configurable: true,
		value(this: HTMLElement, options: ScrollToOptions) {
			scrollTo(options);
			this.scrollTop = options.top ?? 0;
		},
	});
}

function restoreGeometry() {
	for (const [name, descriptor] of Object.entries(descriptors)) {
		if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
		else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
	}
}

// --- The list under test ----------------------------------------------------

const Harness = defineComponent({
	props: {
		items: { type: Array as PropType<Item[]>, default: () => [] },
		/** A reactive array the test changes in place, instead of `items`. */
		source: { type: Object as PropType<Ref<Item[]>>, default: undefined },
		keep: { type: Array as PropType<string[]>, default: () => [] },
		stickToEnd: { type: Boolean, default: true },
		endThresholdPx: { type: Number, default: 80 },
	},
	setup(props, { expose }) {
		const scrollerRef = ref<HTMLElement | null>(null);
		const list = useVirtualList<Item>({
			items: () => props.source?.value ?? props.items,
			getKey: (item) => item.id,
			estimateSize: () => ESTIMATE,
			scrollerRef,
			overscanPx: 100,
			stickToEnd: props.stickToEnd,
			endThresholdPx: props.endThresholdPx,
			keepMounted: () => props.keep,
		});
		expose(list);
		return () =>
			h('div', { ref: scrollerRef, 'data-scroller': 'true' }, [
				h('div', { style: { height: `${list.paddingTop.value}px` } }),
				...list.rows.value.map((row) =>
					h(
						'div',
						{
							key: row.key,
							ref: list.measure(row.key),
							'data-key': row.key,
							style: row.gapBefore > 0 ? { marginTop: `${row.gapBefore}px` } : undefined,
						},
						[h('button', { 'data-button': row.key }, row.key)]
					)
				),
				h('div', { style: { height: `${list.paddingBottom.value}px` } }),
			]);
	},
});

const items = (from: number, to: number): Item[] =>
	Array.from({ length: to - from }, (_, i) => ({ id: `r${from + i}` }));

let wrapper: VueWrapper | undefined;

function mountList(props: {
	items?: Item[];
	source?: Ref<Item[]>;
	keep?: string[];
	stickToEnd?: boolean;
	endThresholdPx?: number;
}) {
	wrapper = mount(Harness, { props, attachTo: document.body });
	return wrapper;
}

const scroller = () => wrapper!.element as HTMLElement;
const mountedKeys = () =>
	Array.from(scroller().querySelectorAll<HTMLElement>('[data-key]')).map(
		(el) => el.dataset['key']!
	);

/** A reader scroll: move, then the scroll event the browser would fire. */
async function scrollReader(top: number) {
	scroller().scrollTop = top;
	scroller().dispatchEvent(new Event('scroll'));
	await nextTick();
	observer().deliverRows();
	await runFrame();
}

beforeEach(() => {
	real = new Map();
	frames = [];
	FakeResizeObserver.instances = [];
	scrollTo.mockClear();
	vi.stubGlobal('ResizeObserver', FakeResizeObserver);
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		frames.push(callback);
		return frames.length;
	});
	vi.stubGlobal('cancelAnimationFrame', () => {
		frames = [];
	});
	installGeometry();
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
	vi.unstubAllGlobals();
	restoreGeometry();
});

describe('useVirtualList', () => {
	it('opens at the end and mounts only the viewport plus the overscan', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();

		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(scrollTo.mock.calls[0]![0]).toMatchObject({ top: 25_000, behavior: 'auto' });
		expect(scroller().scrollTop).toBe(24_600);
		// 400px viewport + 100px overscan above, 50px rows: rows 490..499.
		expect(mountedKeys()).toEqual(items(490, 500).map((i) => i.id));
	});

	it('mounts a bounded window wherever the reader is, and reaches both ends', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();

		await scrollReader(10_000);
		expect(mountedKeys()).toEqual(items(198, 211).map((i) => i.id));

		await scrollReader(0);
		expect(mountedKeys()[0]).toBe('r0');
		expect(mountedKeys().length).toBeLessThanOrEqual(11);

		await scrollReader(1e9);
		expect(mountedKeys().at(-1)).toBe('r499');
	});

	it('keeps the visible row in place when a row above it is measured taller', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		await scrollReader(10_000);

		// Row 198 sits in the overscan above the viewport and turns out 80px tall.
		real.set('r198', 80);
		observer().deliver([scroller().querySelector('[data-key="r198"]')!]);

		// Corrected inside the observer callback, before the frame is painted.
		expect(scroller().scrollTop).toBe(10_030);
		await runFrame();
		expect(scroller().scrollTop).toBe(10_030);
		expect(mountedKeys()[0]).toBe('r198');
	});

	it('defers re-rendering a measurement to the next frame', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		await scrollReader(10_000);
		const before = wrapper!.html();

		real.set('r205', 300);
		observer().deliver([scroller().querySelector('[data-key="r205"]')!]);
		await nextTick();
		// No reactive write inside the callback: the browser would report a
		// "ResizeObserver loop completed with undelivered notifications" error.
		expect(wrapper!.html()).toBe(before);
		expect(frames).toHaveLength(1);

		await runFrame();
		// Row 205 now reaches past the overscan, so the rows after it unmount.
		expect(mountedKeys().at(-1)).toBe('r205');
	});

	it('keeps a reader at the end there while the last row grows', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		observer().deliverRows();
		await runFrame();
		expect(scroller().scrollTop).toBe(24_600);

		real.set('r499', 150);
		observer().deliver([scroller().querySelector('[data-key="r499"]')!]);

		expect(scroller().scrollTop).toBe(24_700);
	});

	it('retargets a smooth scroll to the end instead of cutting it short', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		await scrollReader(24_560);
		const list = wrapper!.vm as unknown as { scrollToEnd: (b: ScrollBehavior) => void };
		list.scrollToEnd('smooth');
		scrollTo.mockClear();

		// The last row grows while the smooth scroll is still on its way.
		real.set('r499', 150);
		observer().deliver([scroller().querySelector('[data-key="r499"]')!]);

		expect(scrollTo).toHaveBeenCalledTimes(1);
		expect(scrollTo.mock.calls[0]![0]).toMatchObject({ top: 25_100, behavior: 'smooth' });
	});

	it('leaves a reader in the history where they are while the last row grows', async () => {
		mountList({ items: items(0, 500), endThresholdPx: 20 });
		await nextTick();
		// 40px up from the end: the last row is partly visible, but the reader
		// scrolled away from the end.
		await scrollReader(24_560);

		real.set('r499', 150);
		observer().deliver([scroller().querySelector('[data-key="r499"]')!]);

		expect(scroller().scrollTop).toBe(24_560);
	});

	it('keeps the position when older rows are prepended', async () => {
		mountList({ items: items(100, 500) });
		await nextTick();
		await scrollReader(5_000); // row r200 at the top

		await wrapper!.setProps({ items: items(0, 500) });
		await nextTick();

		expect(scroller().scrollTop).toBe(10_000);
		expect(mountedKeys()).toContain('r200');
		expect(mountedKeys()[0]).toBe('r198');
	});

	it('holds on to the next visible row when the top one is deleted', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		await scrollReader(10_000); // r200 at the top, r201 50px below it

		await wrapper!.setProps({ items: items(0, 500).filter((i) => i.id !== 'r200') });
		await nextTick();

		// r201 moved up into r200's place; scrolling up 50px keeps it 50px down.
		expect(scroller().scrollTop).toBe(9_950);
	});

	it('keeps the position when a row above the viewport is deleted', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		await scrollReader(10_000);

		await wrapper!.setProps({ items: items(0, 500).filter((i) => i.id !== 'r10') });
		await nextTick();

		expect(scroller().scrollTop).toBe(9_950);
	});

	it('keeps the visible row in place when a row above it gains padding', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		await scrollReader(10_000);

		// Row 198, in the overscan above r200, gets 16px of top padding: its
		// border box grows, its content box does not.
		real.set('r198', 66);
		observer().deliverPaddingChange(scroller().querySelector('[data-key="r198"]')!);

		expect(scroller().scrollTop).toBe(10_016);
	});

	it('keeps the position when older rows are prepended to the same array', async () => {
		const source = ref(items(100, 500));
		mountList({ source });
		await nextTick();
		await scrollReader(5_000); // row r200 at the top

		source.value.unshift(...items(0, 100));
		// One tick for the re-render, one for the scroll correction after it.
		await nextTick();
		await nextTick();

		expect(scroller().scrollTop).toBe(10_000);
		expect(mountedKeys()).toContain('r200');
	});

	it('holds on to the next visible row when the top one is spliced out', async () => {
		const source = ref(items(0, 500));
		mountList({ source });
		await nextTick();
		await scrollReader(10_000);

		source.value.splice(200, 1);
		// One tick for the re-render, one for the scroll correction after it.
		await nextTick();
		await nextTick();

		expect(scroller().scrollTop).toBe(9_950);
	});

	it('forgets the height of a row removed in place', async () => {
		const source = ref(items(0, 500));
		mountList({ source });
		await nextTick();
		await scrollReader(10_000);
		real.set('r205', 300);
		observer().deliver([scroller().querySelector('[data-key="r205"]')!]);
		await runFrame();
		await scrollReader(0); // r205 unmounted, its 300px still cached
		expect(scroller().scrollHeight).toBe(25_250);

		source.value.splice(205, 1);
		await nextTick();
		source.value.splice(205, 0, { id: 'r205' });
		await nextTick();

		// Back at its estimate: the removal pruned the cached height.
		expect(scroller().scrollHeight).toBe(25_000);
	});

	it('keeps the position when a narrower viewport makes every row taller', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		await scrollReader(10_000);

		for (const key of mountedKeys()) real.set(key, 60);
		observer().deliverRows();

		// The two overscan rows above r200 grew by 10px each.
		expect(scroller().scrollTop).toBe(10_020);
	});

	it('opens a list whose rows were all replaced at its end', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		await scrollReader(10_000);

		await wrapper!.setProps({ items: items(1000, 1300) });
		await nextTick();

		expect(scroller().scrollTop).toBe(300 * ESTIMATE - VIEWPORT);
		expect(mountedKeys().at(-1)).toBe('r1299');
	});

	it('keeps a row mounted out of view while it is kept', async () => {
		mountList({ items: items(0, 500), keep: ['r5'] });
		await nextTick();

		expect(mountedKeys()[0]).toBe('r5');
		expect(mountedKeys()[1]).toBe('r490');
		// The kept row sits at its real position: 5 rows of spacer above it, and
		// the rows between it and the window as a gap.
		const kept = scroller().querySelector<HTMLElement>('[data-key="r5"]')!;
		expect((kept.previousElementSibling as HTMLElement).style.height).toBe('250px');
		const next = scroller().querySelector<HTMLElement>('[data-key="r490"]')!;
		expect(next.style.marginTop).toBe(`${(490 - 6) * ESTIMATE}px`);
		expect(contentHeight(scroller())).toBe(25_000);
	});

	it('keeps the row with keyboard focus mounted when the reader scrolls away', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		const button = scroller().querySelector<HTMLElement>('[data-button="r495"]')!;
		button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

		await scrollReader(0);

		expect(mountedKeys()).toContain('r495');
		expect(scroller().querySelector('[data-button="r495"]')).toBe(button);
	});

	it('jumps instead of animating through rows that are not mounted', async () => {
		mountList({ items: items(0, 500) });
		await nextTick();
		await scrollReader(24_560);
		const list = wrapper!.vm as unknown as { scrollToEnd: (b: ScrollBehavior) => void };

		scrollTo.mockClear();
		list.scrollToEnd('smooth');
		expect(scrollTo.mock.calls[0]![0]).toMatchObject({ behavior: 'smooth' });

		await scrollReader(1_000);
		scrollTo.mockClear();
		list.scrollToEnd('smooth');
		expect(scrollTo.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
	});

	it('lets go of the observer, the frame and the listeners on unmount', async () => {
		const added = vi.spyOn(HTMLElement.prototype, 'addEventListener');
		mountList({ items: items(0, 500) });
		await nextTick();
		const el = scroller();
		// happy-dom registers its own listeners too; these are the list's.
		const listeners = added.mock.calls
			.filter((_, i) => added.mock.contexts[i] === el)
			.filter(([type]) => ['scroll', 'focusin', 'focusout'].includes(type))
			.map(([type, listener]) => [type, listener] as const);
		const removed = vi.spyOn(el, 'removeEventListener');
		real.set('r495', 80);
		observer().deliver([el.querySelector('[data-key="r495"]')!]);
		expect(frames).toHaveLength(1);

		wrapper!.unmount();
		wrapper = undefined;

		expect(observer().disconnected).toBe(true);
		expect(frames).toHaveLength(0);
		expect([...new Set(listeners.map(([type]) => type))].sort()).toEqual([
			'focusin',
			'focusout',
			'scroll',
		]);
		for (const [type, listener] of listeners) {
			expect(removed).toHaveBeenCalledWith(type, listener);
		}
	});
});
