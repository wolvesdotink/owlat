// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { usePostboxFrameAutosize } from '../usePostboxFrameAutosize';

// ── Controllable animation frames ───────────────────────────────────────────
let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
function runFrame() {
	const due = [...frameQueue.values()];
	frameQueue = new Map();
	for (const cb of due) cb(0);
}

// ── Mock ResizeObserver ─────────────────────────────────────────────────────
class MockResizeObserver {
	static instances: MockResizeObserver[] = [];
	targets: Element[] = [];
	disconnected = false;
	constructor(private readonly callback: ResizeObserverCallback) {
		MockResizeObserver.instances.push(this);
	}
	observe(target: Element) {
		this.targets.push(target);
	}
	unobserve() {}
	disconnect() {
		this.disconnected = true;
		this.targets = [];
	}
	fire() {
		this.callback([], this as unknown as ResizeObserver);
	}
}

// ── A fake frame document whose parse state and height the test drives ─────
interface FakeDoc {
	readyState: DocumentReadyState;
	URL: string;
	documentElement: { scrollHeight: number };
	body: object;
}
function fakeDoc(scrollHeight: number, readyState: DocumentReadyState = 'interactive'): FakeDoc {
	return { readyState, URL: 'about:srcdoc', documentElement: { scrollHeight }, body: {} };
}

function makeFrame(initial: FakeDoc | null) {
	const iframe = document.createElement('iframe');
	let current = initial;
	Object.defineProperty(iframe, 'contentDocument', {
		configurable: true,
		get: () => current,
	});
	return {
		iframe,
		setDoc(doc: FakeDoc | null) {
			current = doc;
		},
	};
}

let scope: EffectScope;

beforeEach(() => {
	frameQueue = new Map();
	nextFrameId = 1;
	MockResizeObserver.instances = [];
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		const id = nextFrameId++;
		frameQueue.set(id, cb);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => {
		frameQueue.delete(id);
	});
	vi.stubGlobal('ResizeObserver', MockResizeObserver);
	scope = effectScope();
});

afterEach(() => {
	scope.stop();
});

function setup(initial: FakeDoc | null, minHeight = 120) {
	const frame = makeFrame(initial);
	const iframeRef = ref<HTMLIFrameElement | null>(frame.iframe);
	const srcdoc = ref('<p>one</p>');
	const heights: number[] = [];
	const api = scope.run(() =>
		usePostboxFrameAutosize({
			iframeRef,
			srcdoc,
			minHeight: () => minHeight,
			onHeight: (h) => heights.push(h),
		})
	)!;
	return { ...frame, iframeRef, srcdoc, heights, api };
}

describe('usePostboxFrameAutosize', () => {
	it('sizes the frame once its document is parsed, without waiting for load', async () => {
		const blank = { ...fakeDoc(0, 'complete'), URL: 'about:blank' };
		const { iframe, setDoc, heights } = setup(blank);
		await nextTick();
		// The initial about:blank is never measured.
		runFrame();
		expect(heights).toEqual([]);

		// The srcdoc document is still parsing: keep waiting.
		const doc = fakeDoc(900, 'loading');
		setDoc(doc);
		runFrame();
		expect(heights).toEqual([]);

		// DOMContentLoaded: measured before any image (and so `load`) arrives.
		doc.readyState = 'interactive';
		runFrame();
		expect(heights).toEqual([900]);
		expect(iframe.style.height).toBe('900px');
		expect(MockResizeObserver.instances).toHaveLength(1);
		expect(MockResizeObserver.instances[0]!.targets).toContain(doc.documentElement);
	});

	it('follows the document with a ResizeObserver, one measurement per frame', async () => {
		const doc = fakeDoc(400);
		const { iframe, heights } = setup(doc);
		await nextTick();
		expect(heights).toEqual([400]);

		const observer = MockResizeObserver.instances[0]!;
		// An image lands: the observer fires several times before the next paint.
		doc.documentElement.scrollHeight = 1200;
		observer.fire();
		observer.fire();
		observer.fire();
		expect(heights).toEqual([400]);
		runFrame();
		expect(heights).toEqual([400, 1200]);
		expect(iframe.style.height).toBe('1200px');
	});

	it('ignores changes under one pixel and respects the floor', async () => {
		const doc = fakeDoc(50);
		const { heights } = setup(doc, 120);
		await nextTick();
		// Short content is floored at the minimum height.
		expect(heights).toEqual([120]);

		const observer = MockResizeObserver.instances[0]!;
		doc.documentElement.scrollHeight = 600;
		observer.fire();
		runFrame();
		doc.documentElement.scrollHeight = 600.4;
		observer.fire();
		runFrame();
		expect(heights).toEqual([120, 600]);
	});

	it('never binds the outgoing document after a srcdoc change', async () => {
		const first = fakeDoc(300, 'complete');
		const { setDoc, srcdoc, heights } = setup(first);
		await nextTick();
		const firstObserver = MockResizeObserver.instances[0]!;

		srcdoc.value = '<p>two</p>';
		await nextTick();
		expect(firstObserver.disconnected).toBe(true);
		// The navigation has not committed yet; the old document is still there.
		runFrame();
		expect(heights).toEqual([300]);

		setDoc(fakeDoc(700));
		runFrame();
		expect(heights).toEqual([300, 700]);
		expect(MockResizeObserver.instances).toHaveLength(2);
	});

	it('still measures on load as a fallback', async () => {
		const { iframe, setDoc, heights } = setup(null);
		await nextTick();
		setDoc(fakeDoc(500, 'complete'));
		iframe.dispatchEvent(new Event('load'));
		expect(heights).toEqual([500]);
	});

	it('disconnects from a frame that is swapped out, and on dispose', async () => {
		const { iframeRef, heights } = setup(fakeDoc(200));
		await nextTick();
		const firstObserver = MockResizeObserver.instances[0]!;

		const replacement = makeFrame(fakeDoc(800));
		iframeRef.value = replacement.iframe;
		await nextTick();
		expect(firstObserver.disconnected).toBe(true);
		expect(heights).toEqual([200, 800]);

		const secondObserver = MockResizeObserver.instances[1]!;
		scope.stop();
		expect(secondObserver.disconnected).toBe(true);
		// A load after dispose does nothing.
		replacement.iframe.dispatchEvent(new Event('load'));
		expect(heights).toEqual([200, 800]);
	});

	it('cancels a pending measurement when the frame goes away', async () => {
		const doc = fakeDoc(200);
		const { iframeRef, heights } = setup(doc);
		await nextTick();
		doc.documentElement.scrollHeight = 900;
		MockResizeObserver.instances[0]!.fire();
		iframeRef.value = null;
		await nextTick();
		runFrame();
		expect(heights).toEqual([200]);
	});
});
