// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { diffEmails } from '@owlat/email-renderer';
import EmailPreviewer from '../EmailPreviewer.vue';

/**
 * A lazily loaded panel shows a compact loading state while its chunk is slow
 * (plan item OW-060), and a failure in place of the panel when it does not load.
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
			await w.find('button[title="Render options"]').trigger('click');
			// Fast loads skip the placeholder; Vue's default 200 ms delay applies.
			expect(w.find('.ep-panel-loading').exists()).toBe(false);
			await vi.advanceTimersByTimeAsync(250);

			const loading = w.find('.ep-panel-loading');
			expect(loading.attributes('role')).toBe('status');
			expect(loading.text()).toBe('Loading render options…');
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

	it('shows a failure in place of a panel that does not load', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const w = mountPreviewer({
				emailDiff: diffEmails('<p>Hi</p>', '<p>Hello</p>'),
			});
			await w.find('button[title="Compare changes"]').trigger('click');
			await vi.dynamicImportSettled();
			await flushPromises();

			const failed = w.find('.ep-panel-loading');
			expect(failed.attributes('role')).toBe('alert');
			expect(failed.text()).toContain("Couldn't load changes");
		} finally {
			errors.mockRestore();
			warns.mockRestore();
		}
	});
});
