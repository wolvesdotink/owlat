// @vitest-environment happy-dom
/**
 * useRememberedScroll puts the thread list back at its remembered offset on
 * mount and when the reader closes. The Postbox page no longer remounts the
 * list per open, so a list pane hidden (`display: none`) behind the reader
 * would otherwise come back at the top. A folder switch hands the same list a
 * new key, and the list moves to that folder's offset (or the top).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref, type Ref } from 'vue';
import { rememberScroll, useRememberedScroll } from '../usePostboxVirtualList';

let wrapper: VueWrapper | null = null;

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function mountList(key: string | Ref<string>, activeMessageId = ref<string | null>(null)) {
	const onRestored = vi.fn();
	const scrollEl = ref<HTMLElement | null>(null);
	wrapper = mount(
		defineComponent({
			setup() {
				useRememberedScroll({
					scrollEl,
					key: typeof key === 'string' ? ref(key) : key,
					activeMessageId: () => activeMessageId.value,
					onRestored,
				});
				return () => h('div', { ref: scrollEl });
			},
		})
	);
	return { el: () => scrollEl.value!, activeMessageId, onRestored };
}

describe('useRememberedScroll', () => {
	it('restores the remembered offset on mount', async () => {
		rememberScroll('test:mount', 300);
		const { el, onRestored } = mountList('test:mount');
		await flushPromises();
		expect(el().scrollTop).toBe(300);
		expect(onRestored).toHaveBeenCalledTimes(1);
	});

	it('restores it again when the reader closes over a hidden list', async () => {
		rememberScroll('test:reader', 480);
		const { el, activeMessageId, onRestored } = mountList('test:reader');
		await flushPromises();
		onRestored.mockClear();

		activeMessageId.value = 'msg-1';
		await flushPromises();
		// The pane went display:none behind the reader and lost its offset.
		el().scrollTop = 0;

		activeMessageId.value = null;
		await flushPromises();
		expect(el().scrollTop).toBe(480);
		expect(onRestored).toHaveBeenCalledTimes(1);
	});

	it('leaves a list that kept its offset alone', async () => {
		rememberScroll('test:visible', 120);
		const { activeMessageId, onRestored } = mountList('test:visible');
		await flushPromises();
		onRestored.mockClear();

		activeMessageId.value = 'msg-1';
		await flushPromises();
		activeMessageId.value = null;
		await flushPromises();
		expect(onRestored).not.toHaveBeenCalled();
	});

	it("moves to the next folder's offset, or the top, when the key changes", async () => {
		rememberScroll('test:folder-b', 260);
		const key = ref('test:folder-a');
		const { el, onRestored } = mountList(key);
		await flushPromises();
		el().scrollTop = 700;

		key.value = 'test:folder-b';
		await flushPromises();
		expect(el().scrollTop).toBe(260);

		key.value = 'test:folder-unseen';
		await flushPromises();
		expect(el().scrollTop).toBe(0);
		expect(onRestored).toHaveBeenCalledTimes(2);
	});

	it('does nothing for a folder with no remembered offset', async () => {
		const { el, onRestored } = mountList('test:none');
		await flushPromises();
		expect(el().scrollTop).toBe(0);
		expect(onRestored).not.toHaveBeenCalled();
	});
});
