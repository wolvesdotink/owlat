/**
 * The reader's sticky bar shows once the header has scrolled out from under
 * it: measured against the sticky anchor's position on bind and on every
 * scroll of the anchor's scroller. The host publishes its own sticky bar's
 * height, which follows resizes and is 0 while that bar is hidden.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, shallowRef, type Ref } from 'vue';
import { isHeaderScrolledPast, useHeaderScrolledPast } from '../usePostboxReaderStickyBar';
import { useBlockSize } from '../useBlockSize';

/** happy-dom does no layout: each element's top/bottom come from the test. */
function placed(el: HTMLElement, rect: () => { top: number; bottom: number }) {
	el.getBoundingClientRect = () => rect() as DOMRect;
	return el;
}

/**
 * A scroller holding the anchor and a 100px header. The anchor sticks at the
 * scroller's top (0) once the article has scrolled 40px; the header starts at
 * 40px in the content.
 */
function reader() {
	const scroller = document.createElement('div');
	scroller.style.overflowY = 'auto';
	let scrollTop = 0;
	const anchor = placed(document.createElement('div'), () => {
		const top = Math.max(0, 40 - scrollTop);
		return { top, bottom: top };
	});
	const header = placed(document.createElement('header'), () => ({
		top: 40 - scrollTop,
		bottom: 140 - scrollTop,
	}));
	scroller.append(anchor, header);
	document.body.append(scroller);
	onTestFinished(() => scroller.remove());
	return {
		scroller,
		anchor,
		header,
		scrollTo(top: number) {
			scrollTop = top;
			scroller.dispatchEvent(new Event('scroll'));
		},
	};
}

function mountPast(header: Ref<HTMLElement | null>, anchor: Ref<HTMLElement | null>) {
	let past!: Ref<boolean>;
	const w = mount(
		defineComponent({
			setup() {
				past = useHeaderScrolledPast(header, anchor);
				return () => h('div');
			},
		})
	);
	onTestFinished(() => w.unmount());
	return () => past.value;
}

describe('isHeaderScrolledPast', () => {
	it('is true only once the header bottom reaches the anchor', () => {
		const r = reader();
		expect(isHeaderScrolledPast(r.header, r.anchor)).toBe(false);
		r.scrollTo(139);
		expect(isHeaderScrolledPast(r.header, r.anchor)).toBe(false);
		r.scrollTo(140);
		expect(isHeaderScrolledPast(r.header, r.anchor)).toBe(true);
	});

	it('counts the line the anchor sticks at, below a host bar above the reader', () => {
		const anchor = placed(document.createElement('div'), () => ({ top: 45, bottom: 45 }));
		const header = placed(document.createElement('header'), () => ({ top: -60, bottom: 40 }));
		expect(isHeaderScrolledPast(header, anchor)).toBe(true);
	});
});

describe('useHeaderScrolledPast', () => {
	it('follows the scroller in both directions', async () => {
		const r = reader();
		const past = mountPast(shallowRef(r.header), shallowRef(r.anchor));
		await nextTick();
		expect(past()).toBe(false);

		r.scrollTo(200);
		expect(past()).toBe(true);

		r.scrollTo(100);
		expect(past()).toBe(false);
	});

	it('measures on bind, so a reader opened already scrolled shows the bar', async () => {
		const r = reader();
		r.scrollTo(500);
		const past = mountPast(shallowRef(r.header), shallowRef(r.anchor));
		await nextTick();
		expect(past()).toBe(true);
	});

	it('is false while either element is missing', async () => {
		const r = reader();
		r.scrollTo(500);
		const header = shallowRef<HTMLElement | null>(null);
		const past = mountPast(header, shallowRef(r.anchor));
		await nextTick();
		expect(past()).toBe(false);

		header.value = r.header;
		await nextTick();
		expect(past()).toBe(true);
	});
});

describe('useBlockSize', () => {
	it('reads the height on bind and follows the ResizeObserver', async () => {
		let notify = () => {};
		const disconnect = vi.fn();
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(cb: () => void) {
					notify = cb;
				}
				observe() {}
				disconnect = disconnect;
			}
		);
		onTestFinished(() => vi.unstubAllGlobals());
		let height = 45;
		const el = document.createElement('div');
		Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => height });
		const target = shallowRef<HTMLElement | null>(el);
		let size!: Ref<number>;
		const w = mount(
			defineComponent({
				setup() {
					size = useBlockSize(() => target.value);
					return () => h('div');
				},
			})
		);
		await nextTick();
		expect(size.value).toBe(45);

		// Hidden at lg (display: none) measures 0.
		height = 0;
		notify();
		expect(size.value).toBe(0);

		target.value = null;
		await nextTick();
		expect(size.value).toBe(0);
		expect(disconnect).toHaveBeenCalled();
		w.unmount();
	});
});
