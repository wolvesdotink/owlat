// @vitest-environment happy-dom
/**
 * The pane divider applies a drag at most once per animation frame: a pointer
 * reports far more often than the screen paints, and every live update
 * re-lays out the list, the reader and its email frames.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxPaneResizer from '../PostboxPaneResizer.vue';

let frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
function runFrame() {
	const due = [...frameQueue.values()];
	frameQueue = new Map();
	for (const cb of due) cb(0);
}

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	frameQueue = new Map();
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		const id = nextFrameId++;
		frameQueue.set(id, cb);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => {
		frameQueue.delete(id);
	});
});

function mountResizer() {
	const paneEl = {
		getBoundingClientRect: () => ({ left: 100, top: 0 }) as DOMRect,
	} as HTMLElement;
	return mount(PostboxPaneResizer, {
		props: { axis: 'width', modelValue: 384, paneEl },
		global: { plugins: [createTestI18n()] },
	});
}

function pointer(type: string, clientX: number, button = 0) {
	const event = new MouseEvent(type, { clientX, button, bubbles: true });
	return event as unknown as PointerEvent;
}

describe('PostboxPaneResizer drag', () => {
	it('emits one live update per frame, with the newest position', async () => {
		const w = mountResizer();
		await w.find('[role="separator"]').trigger('pointerdown', { button: 0 });

		window.dispatchEvent(pointer('pointermove', 500));
		window.dispatchEvent(pointer('pointermove', 520));
		window.dispatchEvent(pointer('pointermove', 540));
		expect(w.emitted('update:modelValue')).toBeUndefined();

		runFrame();
		expect(w.emitted('update:modelValue')).toEqual([[440]]);

		window.dispatchEvent(pointer('pointermove', 560));
		runFrame();
		expect(w.emitted('update:modelValue')).toEqual([[440], [460]]);
	});

	it('lands and commits the last position when released before its frame', async () => {
		const w = mountResizer();
		await w.find('[role="separator"]').trigger('pointerdown', { button: 0 });

		window.dispatchEvent(pointer('pointermove', 600));
		window.dispatchEvent(pointer('pointerup', 600));

		expect(w.emitted('update:modelValue')).toEqual([[500]]);
		expect(w.emitted('commit')).toEqual([[500]]);
		// Nothing is left queued to fire after the drag has ended.
		runFrame();
		expect(w.emitted('update:modelValue')).toEqual([[500]]);
	});

	it('stops listening once the drag ends', async () => {
		const w = mountResizer();
		await w.find('[role="separator"]').trigger('pointerdown', { button: 0 });
		window.dispatchEvent(pointer('pointerup', 384));
		window.dispatchEvent(pointer('pointermove', 600));
		runFrame();
		expect(w.emitted('update:modelValue')).toBeUndefined();
	});
});
