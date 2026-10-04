// @vitest-environment happy-dom
/**
 * The shell's undo-send host: a send leaves the page it was written on (the
 * compose page, Answer mode), so the countdown that can still take it back is
 * mounted by the shell, over whatever page comes next. The toast carries the
 * cancel mutation and the offline outbox, so it loads only once an undo-send
 * window opens, and stays mounted after.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import ComposerOverlay from '../ComposerOverlay.vue';

let undoSend: ReturnType<typeof ref<{ visible: boolean; sendAt: number }>>;

beforeEach(() => {
	undoSend = ref({ visible: false, sendAt: 0 });
	const states: Record<string, unknown> = { 'postbox:undo-send': undoSend };
	Object.assign(globalThis, {
		useState: (key: string, init: () => unknown) => (states[key] ??= ref(init())),
	});
});

function mountOverlay() {
	return mount(ComposerOverlay, {
		global: {
			stubs: {
				Teleport: true,
				LazyPostboxUndoSendToast: { template: '<div data-testid="toast" />' },
			},
		},
	});
}

const hasToast = (wrapper: ReturnType<typeof mountOverlay>) =>
	wrapper.find('[data-testid="toast"]').exists();

describe('ShellComposerOverlay', () => {
	it('leaves the toast unloaded until an undo-send window opens', async () => {
		const wrapper = mountOverlay();
		expect(hasToast(wrapper)).toBe(false);

		undoSend.value = { visible: true, sendAt: Date.now() + 10_000 };
		await nextTick();
		expect(hasToast(wrapper)).toBe(true);
	});

	it('keeps the toast mounted after the window closes, so it can transition out', async () => {
		undoSend.value = { visible: true, sendAt: Date.now() + 10_000 };
		const wrapper = mountOverlay();
		expect(hasToast(wrapper)).toBe(true);

		undoSend.value = { visible: false, sendAt: 0 };
		await nextTick();
		expect(hasToast(wrapper)).toBe(true);
	});
});
