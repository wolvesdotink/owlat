/**
 * Lazily mounted reader bodies (performance plan D8).
 *
 * An expanded message whose body sits far below the fold renders a placeholder
 * of the body's cached frame height and mounts the real body once it nears the
 * viewport. A body already on screen, a forced (print) mount and a browser
 * without IntersectionObserver all mount straight away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import PostboxLazyBody from '../PostboxLazyBody.vue';
import { getPostboxRenderCache, postboxRenderKey } from '../../../utils/postboxRenderCache';
import {
	POSTBOX_BODY_PLACEHOLDER_PX,
	usePostboxMountAllBodies,
	waitForFrameLoads,
} from '../../../composables/postbox/usePostboxLazyBody';

type ObserverRecord = {
	callback: IntersectionObserverCallback;
	options?: IntersectionObserverInit;
	targets: Element[];
	disconnected: boolean;
};
let observers: ObserverRecord[];
let rectTop: number;

class FakeIntersectionObserver {
	record: ObserverRecord;
	constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
		this.record = { callback, options, targets: [], disconnected: false };
		observers.push(this.record);
	}
	observe(el: Element) {
		this.record.targets.push(el);
	}
	disconnect() {
		this.record.disconnected = true;
	}
	unobserve() {}
	takeRecords() {
		return [];
	}
}

function intersect(record: ObserverRecord) {
	record.callback(
		record.targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
		record as unknown as IntersectionObserver
	);
}

beforeEach(() => {
	observers = [];
	rectTop = 5000;
	getPostboxRenderCache().clear();
	vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
	vi.stubGlobal('useAppTheme', () => ({ isDark: ref(false) }));
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
		() =>
			({
				top: rectTop,
				bottom: rectTop + 200,
				left: 0,
				right: 600,
				width: 600,
				height: 200,
			}) as DOMRect
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const LIGHT = { scheme: 'light', showImages: false, loadEverything: false, showQuoted: false };

function mountBody(props: Partial<{ eager: boolean; imagesAllowed: boolean }> = {}) {
	return mount(PostboxLazyBody, {
		props: { messageId: 'm1', forceLight: false, imagesAllowed: false, ...props },
		slots: { default: () => h('div', { class: 'real-body' }, 'body') },
		attachTo: document.body,
	});
}

function setHeight(options: typeof LIGHT, height: number) {
	getPostboxRenderCache().set(postboxRenderKey('m1', options as never), {
		srcdoc: '',
		renderScheme: 'light',
		kind: 'simple',
		detection: { pixelCount: 0 } as never,
		height,
	});
}

describe('PostboxLazyBody', () => {
	it('holds an off-screen body back behind a placeholder of its cached height', async () => {
		setHeight(LIGHT, 640);
		const wrapper = mountBody();
		await nextTick();

		expect(wrapper.find('.real-body').exists()).toBe(false);
		const placeholder = wrapper.get('[data-testid="postbox-lazy-body"]');
		expect(placeholder.attributes('style')).toContain('height: 640px');
		expect(observers).toHaveLength(1);
		expect(observers[0]!.options?.rootMargin).toBe('600px 0px');

		intersect(observers[0]!);
		await nextTick();
		expect(wrapper.find('.real-body').exists()).toBe(true);
		expect(observers[0]!.disconnected).toBe(true);
		wrapper.unmount();
	});

	it('sizes the placeholder from another render of the message, else a default', async () => {
		setHeight({ ...LIGHT, showQuoted: true }, 910);
		const cached = mountBody();
		await nextTick();
		expect(cached.get('[data-testid="postbox-lazy-body"]').attributes('style')).toContain(
			'height: 910px'
		);
		cached.unmount();

		getPostboxRenderCache().clear();
		const fresh = mountBody();
		await nextTick();
		expect(fresh.get('[data-testid="postbox-lazy-body"]').attributes('style')).toContain(
			`height: ${POSTBOX_BODY_PLACEHOLDER_PX}px`
		);
		fresh.unmount();
	});

	it('mounts a body that is already near the viewport without waiting for the observer', async () => {
		rectTop = 300;
		const wrapper = mountBody();
		await nextTick();
		expect(wrapper.find('.real-body').exists()).toBe(true);
		expect(observers).toHaveLength(0);
		wrapper.unmount();
	});

	it('mounts at once when eager, and when eager turns on later', async () => {
		const eager = mountBody({ eager: true });
		expect(eager.find('.real-body').exists()).toBe(true);
		eager.unmount();

		const later = mountBody();
		await nextTick();
		expect(later.find('.real-body').exists()).toBe(false);
		await later.setProps({ eager: true });
		expect(later.find('.real-body').exists()).toBe(true);
		expect(observers[0]!.disconnected).toBe(true);
		later.unmount();
	});

	it('mounts straight away where IntersectionObserver is missing', async () => {
		vi.stubGlobal('IntersectionObserver', undefined);
		const wrapper = mountBody();
		await nextTick();
		expect(wrapper.find('.real-body').exists()).toBe(true);
		wrapper.unmount();
	});
});

describe('usePostboxMountAllBodies', () => {
	function host() {
		const threadKey = ref('t1');
		let api!: ReturnType<typeof usePostboxMountAllBodies>;
		const wrapper = mount(
			defineComponent({
				setup() {
					api = usePostboxMountAllBodies({ threadKey: () => threadKey.value, root: ref(null) });
					return () => h('div');
				},
			})
		);
		return { wrapper, threadKey, api: () => api };
	}

	it('mounts every body before printing, and prints at once when they already are', async () => {
		const { wrapper, api } = host();
		expect(api().mountAll.value).toBe(false);
		const ready = api().preparePrint();
		expect(ready).toBeInstanceOf(Promise);
		expect(api().mountAll.value).toBe(true);
		await ready;
		expect(api().preparePrint()).toBeUndefined();
		wrapper.unmount();
	});

	it("mounts every body on the browser's own print and resets per thread", async () => {
		const { wrapper, threadKey, api } = host();
		window.dispatchEvent(new Event('beforeprint'));
		expect(api().mountAll.value).toBe(true);
		threadKey.value = 't2';
		await nextTick();
		expect(api().mountAll.value).toBe(false);
		wrapper.unmount();
	});
});

describe('waitForFrameLoads', () => {
	it('waits for pending frames to load', async () => {
		const root = document.createElement('div');
		const frame = document.createElement('iframe');
		root.appendChild(frame);
		let done = false;
		const waiting = waitForFrameLoads(root, 10_000).then(() => (done = true));
		await Promise.resolve();
		expect(done).toBe(false);
		frame.dispatchEvent(new Event('load'));
		await waiting;
		expect(done).toBe(true);
	});

	it('gives up after the timeout', async () => {
		vi.useFakeTimers();
		const root = document.createElement('div');
		root.appendChild(document.createElement('iframe'));
		let done = false;
		const waiting = waitForFrameLoads(root, 1500).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(1500);
		await waiting;
		expect(done).toBe(true);
		vi.useRealTimers();
	});
});
