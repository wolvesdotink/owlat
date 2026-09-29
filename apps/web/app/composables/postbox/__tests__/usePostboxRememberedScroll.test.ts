// @vitest-environment happy-dom
/**
 * useRememberedScroll puts the thread list back at its remembered offset on
 * mount and when the reader closes. The Postbox page no longer remounts the
 * list per open, so a list pane hidden (`display: none`) behind the reader
 * would otherwise come back at the top.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { rememberScroll, useRememberedScroll } from '../usePostboxVirtualList';

let wrapper: VueWrapper | null = null;

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

function mountList(key: string, activeMessageId = ref<string | null>(null)) {
	const onRestored = vi.fn();
	const scrollEl = ref<HTMLElement | null>(null);
	wrapper = mount(
		defineComponent({
			setup() {
				useRememberedScroll({
					scrollEl,
					key: ref(key),
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

	it('does nothing for a folder with no remembered offset', async () => {
		const { el, onRestored } = mountList('test:none');
		await flushPromises();
		expect(el().scrollTop).toBe(0);
		expect(onRestored).not.toHaveBeenCalled();
	});
});
