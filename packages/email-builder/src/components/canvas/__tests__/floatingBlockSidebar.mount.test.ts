// @vitest-environment happy-dom
//
// The floating block sidebar follows the canvas: it listens for scroll on the
// canvas's `.document-canvas__bg` scroll root, for window resize, and for canvas
// resizes, and once the canvas scrolls past the top of that root it sticks just
// below the root's top edge (not the viewport's, which would put it over the app
// header). When the canvas element changes, the listener has to come off the
// root it was installed on, not the root of the new element, and unmounting has
// to remove the last one. Geometry is read at most once per animation frame no
// matter how many scroll/resize events arrive in between.
import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import FloatingBlockSidebar from '../FloatingBlockSidebar.vue';

type Listener = EventListenerOrEventListenerObject;

/** Counts the scroll listeners currently attached to an element. */
function trackScrollListeners(target: EventTarget) {
	const live = new Set<Listener>();
	const add = target.addEventListener.bind(target);
	const remove = target.removeEventListener.bind(target);
	target.addEventListener = ((type: string, listener: Listener, options?: unknown) => {
		if (type === 'scroll') live.add(listener);
		add(type, listener, options as AddEventListenerOptions);
	}) as typeof target.addEventListener;
	target.removeEventListener = ((type: string, listener: Listener, options?: unknown) => {
		if (type === 'scroll') live.delete(listener);
		remove(type, listener, options as EventListenerOptions);
	}) as typeof target.removeEventListener;
	return { count: () => live.size };
}

interface Root {
	root: HTMLElement;
	canvas: HTMLElement;
	listeners: { count: () => number };
	reads: () => number;
	rootReads: () => number;
	/** Moves the canvas to a new viewport top, as scrolling the root does. */
	scrollCanvasTo: (top: number) => void;
}

/**
 * A `.document-canvas__bg` scroll root holding a canvas at the given rect. The
 * root's own top edge defaults to 0 (happy-dom's empty rect); in the app it sits
 * below the app header and the editor toolbar.
 */
function makeRoot(left = 200, top = 100, rootTop = 0): Root {
	const root = document.createElement('div');
	root.className = 'document-canvas__bg';
	const canvas = document.createElement('div');
	root.appendChild(canvas);
	document.body.appendChild(root);
	onTestFinished(() => root.remove());
	let reads = 0;
	let rootReads = 0;
	let canvasTop = top;
	canvas.getBoundingClientRect = () => {
		reads++;
		return {
			left,
			top: canvasTop,
			right: left + 600,
			bottom: canvasTop + 800,
			width: 600,
			height: 800,
		} as DOMRect;
	};
	root.getBoundingClientRect = () => {
		rootReads++;
		return {
			left: 0,
			top: rootTop,
			right: 1440,
			bottom: 900,
			width: 1440,
			height: 900 - rootTop,
		} as DOMRect;
	};
	return {
		root,
		canvas,
		listeners: trackScrollListeners(root),
		reads: () => reads,
		rootReads: () => rootReads,
		scrollCanvasTo: (next) => {
			canvasTop = next;
		},
	};
}

const observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
	observed = new Set<Element>();
	constructor(public callback: ResizeObserverCallback) {
		observers.push(this);
	}
	observe(el: Element) {
		this.observed.add(el);
	}
	unobserve(el: Element) {
		this.observed.delete(el);
	}
	disconnect() {
		this.observed.clear();
	}
	fire() {
		this.callback([], this as unknown as ResizeObserver);
	}
}
const liveObservers = () => observers.filter((o) => o.observed.size > 0);

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function flushFrame() {
	const pending = frames;
	frames = new Map();
	for (const cb of pending.values()) cb(0);
}

let windowResize: { count: () => number };
let wrapper: VueWrapper | null = null;

beforeEach(() => {
	observers.length = 0;
	frames = new Map();
	nextFrame = 1;
	vi.stubGlobal('ResizeObserver', FakeResizeObserver);
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		const id = nextFrame++;
		frames.set(id, cb);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => {
		frames.delete(id);
	});
	const live = new Set<Listener>();
	const add = window.addEventListener.bind(window);
	const remove = window.removeEventListener.bind(window);
	vi.spyOn(window, 'addEventListener').mockImplementation(((
		type: string,
		listener: Listener,
		options?: unknown
	) => {
		if (type === 'resize') live.add(listener);
		add(type, listener, options as AddEventListenerOptions);
	}) as typeof window.addEventListener);
	vi.spyOn(window, 'removeEventListener').mockImplementation(((
		type: string,
		listener: Listener,
		options?: unknown
	) => {
		if (type === 'resize') live.delete(listener);
		remove(type, listener, options as EventListenerOptions);
	}) as typeof window.removeEventListener);
	windowResize = { count: () => live.size };
});

afterEach(() => {
	// Unmount while the stubbed observer, frame and listener globals are still
	// installed: the sidebar's teardown goes through them. The setup's own
	// unmount would run after they are restored.
	wrapper?.unmount();
	wrapper = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function mountSidebar(canvasElement: HTMLElement | null) {
	wrapper = mount(FloatingBlockSidebar, { props: { canvasElement, visible: true } });
	return wrapper;
}

describe('FloatingBlockSidebar scroll-root ownership', () => {
	it('detaches every prior scroll root when the canvas element keeps changing', async () => {
		const roots = [makeRoot(), makeRoot(), makeRoot()];
		const w = mountSidebar(roots[0]!.canvas);
		expect(roots[0]!.listeners.count()).toBe(1);

		for (const index of [1, 2, 0, 2, 1]) {
			await w.setProps({ canvasElement: roots[index]!.canvas });
			for (const [i, r] of roots.entries()) {
				expect(r.listeners.count(), `root ${i} while root ${index} is current`).toBe(
					i === index ? 1 : 0
				);
			}
			expect(windowResize.count()).toBe(1);
			expect(liveObservers()).toHaveLength(1);
			expect([...liveObservers()[0]!.observed]).toEqual([roots[index]!.canvas]);
		}

		w.unmount();
		wrapper = null;
		for (const r of roots) expect(r.listeners.count()).toBe(0);
		expect(windowResize.count()).toBe(0);
		expect(liveObservers()).toHaveLength(0);
	});

	it('detaches the old root when the canvas element goes away', async () => {
		const a = makeRoot();
		const w = mountSidebar(a.canvas);
		await w.setProps({ canvasElement: null });
		expect(a.listeners.count()).toBe(0);
		expect(windowResize.count()).toBe(0);
		expect(liveObservers()).toHaveLength(0);
	});

	it('detaches the old root when the old canvas has been moved out of it', async () => {
		const a = makeRoot();
		const b = makeRoot();
		const w = mountSidebar(a.canvas);
		// The old canvas no longer sits under its scroll root by the time the
		// prop changes, so `closest()` on it would find nothing.
		a.canvas.remove();
		await w.setProps({ canvasElement: b.canvas });
		expect(a.listeners.count()).toBe(0);
		expect(b.listeners.count()).toBe(1);
	});

	it('keeps one listener when two canvases share a scroll root', async () => {
		const a = makeRoot();
		const sibling = document.createElement('div');
		a.root.appendChild(sibling);
		const w = mountSidebar(a.canvas);
		await w.setProps({ canvasElement: sibling });
		expect(a.listeners.count()).toBe(1);
		w.unmount();
		wrapper = null;
		expect(a.listeners.count()).toBe(0);
	});

	it('starts listening once a canvas element arrives after mount', async () => {
		const w = mountSidebar(null);
		const a = makeRoot();
		await w.setProps({ canvasElement: a.canvas });
		expect(a.listeners.count()).toBe(1);
		expect(windowResize.count()).toBe(1);
	});
});

describe('FloatingBlockSidebar geometry updates', () => {
	const toolbar = () => document.body.querySelector<HTMLElement>('[role="toolbar"]')!;

	it('positions synchronously on mount', async () => {
		const a = makeRoot(200, 100);
		mountSidebar(a.canvas);
		await nextTick();
		expect(a.reads()).toBe(1);
		expect(toolbar().style.left).toBe('148px');
		expect(toolbar().style.top).toBe('116px');
	});

	it('reads geometry once per frame under a burst of scroll, resize and observer events', async () => {
		const a = makeRoot(200, 100);
		mountSidebar(a.canvas);
		const before = a.reads();

		for (let i = 0; i < 20; i++) a.root.dispatchEvent(new Event('scroll'));
		window.dispatchEvent(new Event('resize'));
		liveObservers()[0]!.fire();
		expect(a.reads()).toBe(before);

		flushFrame();
		expect(a.reads()).toBe(before + 1);

		// A frame with no events reads nothing; the next burst gets its own frame.
		flushFrame();
		expect(a.reads()).toBe(before + 1);
		a.root.dispatchEvent(new Event('scroll'));
		a.root.dispatchEvent(new Event('scroll'));
		flushFrame();
		expect(a.reads()).toBe(before + 2);
	});

	it('applies the latest geometry when the frame runs', async () => {
		const a = makeRoot(200, 100);
		mountSidebar(a.canvas);
		a.canvas.getBoundingClientRect = () =>
			({ left: 300, top: -50, right: 900, bottom: 750, width: 600, height: 800 }) as DOMRect;
		a.root.dispatchEvent(new Event('scroll'));
		flushFrame();
		await nextTick();
		expect(toolbar().style.left).toBe('248px');
		// Sticky: stays at the top offset once the canvas scrolls past it.
		expect(toolbar().style.top).toBe('16px');
	});

	it('sticks below the scroll root, not the viewport, once the canvas scrolls past it', async () => {
		// The root starts below 120px of app header and editor toolbar.
		const a = makeRoot(200, 144, 120);
		mountSidebar(a.canvas);
		await nextTick();
		expect(toolbar().style.top).toBe('160px');

		a.scrollCanvasTo(-456);
		a.root.dispatchEvent(new Event('scroll'));
		flushFrame();
		await nextTick();
		expect(toolbar().style.top).toBe('136px');
		expect(toolbar().style.left).toBe('148px');
	});

	it('reads the scroll root once per frame together with the canvas', async () => {
		const a = makeRoot(200, 144, 120);
		mountSidebar(a.canvas);
		const canvasBefore = a.reads();
		const rootBefore = a.rootReads();
		expect(rootBefore).toBe(1);

		for (let i = 0; i < 20; i++) a.root.dispatchEvent(new Event('scroll'));
		window.dispatchEvent(new Event('resize'));
		liveObservers()[0]!.fire();
		expect(a.rootReads()).toBe(rootBefore);

		flushFrame();
		expect(a.reads()).toBe(canvasBefore + 1);
		expect(a.rootReads()).toBe(rootBefore + 1);
	});

	it('clamps to the replacement root after a canvas swap', async () => {
		const a = makeRoot(200, -456, 120);
		const b = makeRoot(200, -300, 200);
		const w = mountSidebar(a.canvas);
		await nextTick();
		expect(toolbar().style.top).toBe('136px');

		await w.setProps({ canvasElement: b.canvas });
		await nextTick();
		expect(toolbar().style.top).toBe('216px');
		const aRootReads = a.rootReads();

		b.root.dispatchEvent(new Event('scroll'));
		flushFrame();
		await nextTick();
		expect(toolbar().style.top).toBe('216px');
		expect(a.rootReads()).toBe(aRootReads);
	});

	it('keeps the viewport floor when the scroll root starts above the viewport', async () => {
		const a = makeRoot(200, -456, -80);
		mountSidebar(a.canvas);
		await nextTick();
		expect(toolbar().style.top).toBe('16px');
	});

	it('keeps the viewport floor when the canvas has no scroll root', async () => {
		const canvas = document.createElement('div');
		document.body.appendChild(canvas);
		onTestFinished(() => canvas.remove());
		canvas.getBoundingClientRect = () =>
			({ left: 200, top: -456, right: 800, bottom: 344, width: 600, height: 800 }) as DOMRect;
		mountSidebar(canvas);
		await nextTick();
		expect(toolbar().style.top).toBe('16px');
	});

	it('drops a pending frame on unmount and on a canvas swap', async () => {
		const a = makeRoot();
		const b = makeRoot();
		const w = mountSidebar(a.canvas);
		a.root.dispatchEvent(new Event('scroll'));
		await w.setProps({ canvasElement: b.canvas });
		const aReads = a.reads();
		flushFrame();
		expect(a.reads()).toBe(aReads);

		b.root.dispatchEvent(new Event('scroll'));
		const bReads = b.reads();
		w.unmount();
		wrapper = null;
		flushFrame();
		expect(b.reads()).toBe(bReads);
	});
});
