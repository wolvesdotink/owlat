// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, onErrorCaptured } from 'vue';
import { diffEmails } from '@owlat/email-renderer';
import EmailPreviewer from '../EmailPreviewer.vue';

/**
 * Through the previewer: a lazily loaded panel shows a compact loading state
 * while its chunk is slow (plan item OW-060), and a contained failure in place
 * of the panel when it does not load. lazyPanelRetry.test.ts covers retrying.
 */
const gate = vi.hoisted(() => {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { open, opened };
});

vi.mock('../RenderOptionsPanel.vue', async () => {
	// The time limit only matters if the panel is imported statically again: the
	// import would then block the previewer itself, and the test should fail, not hang.
	await Promise.race([gate.opened, new Promise((resolve) => setTimeout(resolve, 5000))]);
	return {
		// Marks the mock as a module so Vue unwraps `default`, as for a real chunk.
		__esModule: true,
		default: defineComponent({
			emits: ['close'],
			setup: () => () => h('div', { class: 'ep-settings-panel' }, 'Render Options'),
		}),
	};
});

vi.mock('../DiffPanel.vue', async () => {
	throw new Error('chunk failed to load');
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const mountPreviewer = (props: Record<string, unknown> = {}) => {
	wrapper = mount(EmailPreviewer, {
		props: {
			html: '<html><body><p>Hello</p></body></html>',
			autoAnalyze: false,
			showDeviceControls: false,
			...props,
		},
	});
	return wrapper;
};

describe('EmailPreviewer — lazy panel loading and failure states', () => {
	it('shows a loading state until the slow panel arrives', async () => {
		vi.useFakeTimers();
		try {
			const w = mountPreviewer();
			await w.find('button[aria-label="Render options"]').trigger('click');
			// Fast loads skip the placeholder; Vue's default 200 ms delay applies.
			expect(w.find('.ep-panel-loading').exists()).toBe(false);
			await vi.advanceTimersByTimeAsync(250);

			const loading = w.find('.ep-panel-loading');
			expect(loading.attributes('role')).toBe('status');
			expect(loading.text()).toBe('Loading…');
			expect(w.find('.ep-settings-panel').exists()).toBe(false);
		} finally {
			vi.useRealTimers();
		}

		gate.open();
		await vi.dynamicImportSettled();
		await flushPromises();
		expect(wrapper!.find('.ep-panel-loading').exists()).toBe(false);
		expect(wrapper!.find('.ep-settings-panel').exists()).toBe(true);
	});

	it('shows a failure in place of a panel that does not load, without raising it', async () => {
		// The web editor sits in an error boundary; a raised loader error would
		// replace the whole editor with its fallback.
		const captured = vi.fn(() => false);
		const Host = defineComponent({
			setup() {
				onErrorCaptured(captured);
				return () =>
					h(EmailPreviewer, {
						html: '<html><body><p>Hello</p></body></html>',
						autoAnalyze: false,
						showDeviceControls: false,
						emailDiff: diffEmails('<p>Hi</p>', '<p>Hello</p>'),
					});
			},
		});
		const w = mount(Host);
		await w.find('button[aria-label="Compare changes"]').trigger('click');
		await vi.dynamicImportSettled();
		await flushPromises();

		expect(captured).not.toHaveBeenCalled();
		expect(w.find('.ep-toolbar').exists()).toBe(true);
		const failed = w.find('.ep-panel-loading');
		expect(failed.attributes('role')).toBe('alert');
		expect(failed.text()).toContain('Something went wrong. Please try again.');
		expect(failed.attributes('email-diff')).toBeUndefined();

		// Trying again while the chunk still fails stays contained.
		await failed.find('button').trigger('click');
		await vi.dynamicImportSettled();
		await flushPromises();
		expect(w.find('.ep-panel-loading').attributes('role')).toBe('alert');
		expect(w.find('.ep-toolbar').exists()).toBe(true);
		expect(captured).not.toHaveBeenCalled();
		w.unmount();
	});
});
