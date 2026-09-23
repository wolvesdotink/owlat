// @vitest-environment happy-dom
/**
 * Axis labels must never be scaled (#783).
 *
 * The chart used a fixed 320-wide viewBox stretched to `w-full` with
 * `preserveAspectRatio="none"`, so on a wide card every `<text>` glyph was
 * widened along with the line. The fix measures the container and uses that
 * width as the viewBox width, so one user unit is one CSS pixel. happy-dom has
 * no layout engine: `clientWidth` and `ResizeObserver` are faked here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import TrendChart from '../components/ui/TrendChart.vue';
import { mountUi, type MountedUi } from './i18n';

const DATA = [
	{ label: 'Aug 25', value: 10 },
	{ label: 'Aug 26', value: 1010 },
	{ label: 'Aug 27', value: 400 },
];

let containerWidth = 0;
let observers: FakeResizeObserver[] = [];
let originalClientWidth: PropertyDescriptor | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;
let mounted: MountedUi | null = null;

class FakeResizeObserver {
	observed: Element[] = [];
	constructor(private readonly callback: ResizeObserverCallback) {
		observers.push(this);
	}
	observe(el: Element) {
		this.observed.push(el);
	}
	unobserve() {}
	disconnect() {
		this.observed = [];
	}
	fire() {
		this.callback([], this as unknown as ResizeObserver);
	}
}

beforeEach(() => {
	containerWidth = 0;
	observers = [];
	originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get() {
			return containerWidth;
		},
	});
	originalResizeObserver = globalThis.ResizeObserver;
	globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
	mounted?.unmount();
	mounted = null;
	if (originalClientWidth) {
		Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
	}
	if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
});

function svg(): SVGSVGElement {
	const el = mounted!.el.querySelector('svg');
	if (!el) throw new Error('chart svg not rendered');
	return el;
}

describe('UiTrendChart sizing', () => {
	it('uses the measured container width as the viewBox width', async () => {
		containerWidth = 812;
		mounted = mountUi(TrendChart, { data: DATA });
		await nextTick();
		expect(svg().getAttribute('viewBox')).toBe('0 0 812 120');
	});

	it('never stretches the drawing non-uniformly', async () => {
		containerWidth = 812;
		mounted = mountUi(TrendChart, { data: DATA });
		await nextTick();
		expect(svg().getAttribute('preserveAspectRatio')).not.toBe('none');
	});

	it('follows container resizes and keeps the last label on the right edge', async () => {
		containerWidth = 400;
		mounted = mountUi(TrendChart, { data: DATA });
		await nextTick();
		containerWidth = 960;
		for (const o of observers) o.fire();
		await nextTick();
		expect(svg().getAttribute('viewBox')).toBe('0 0 960 120');
		const texts = Array.from(svg().querySelectorAll('text'));
		const last = texts.find((t) => t.textContent?.trim() === 'Aug 27');
		// right padding is 12 → the last x label anchors at width - 12
		expect(last?.getAttribute('x')).toBe('948');
	});

	it('keeps the last good width while the container is hidden', async () => {
		containerWidth = 700;
		mounted = mountUi(TrendChart, { data: DATA });
		await nextTick();
		containerWidth = 0;
		for (const o of observers) o.fire();
		await nextTick();
		expect(svg().getAttribute('viewBox')).toBe('0 0 700 120');
	});

	it('disconnects its observer on unmount', async () => {
		containerWidth = 500;
		mounted = mountUi(TrendChart, { data: DATA });
		await nextTick();
		expect(observers.some((o) => o.observed.length > 0)).toBe(true);
		mounted.unmount();
		mounted = null;
		expect(observers.every((o) => o.observed.length === 0)).toBe(true);
	});
});
