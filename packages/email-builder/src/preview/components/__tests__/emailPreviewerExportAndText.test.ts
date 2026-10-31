// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EmailPreviewer from '../EmailPreviewer.vue';

/**
 * The previewer's export menu, its Text view with the manual plain-text body,
 * the render warnings and the subject line.
 */
let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const HTML = '<html><body><p>Hi</p></body></html>';

const mountPreviewer = (props: Record<string, unknown> = {}) => {
	wrapper = mount(EmailPreviewer, {
		props: { html: HTML, autoAnalyze: false, showDeviceControls: false, ...props },
	});
	return wrapper;
};

const exportButton = (w: VueWrapper) => w.find('.ep-export-wrapper .ep-control-btn');
const menuItem = (w: VueWrapper, label: string) =>
	w.findAll('.ep-export-item').find((b) => b.text().includes(label));
const viewButton = (w: VueWrapper, label: string) =>
	w.findAll('.ep-view-btn').find((b) => b.text().includes(label))!;

describe('EmailPreviewer — export menu', () => {
	it('copies the HTML, closes, and confirms the copy for two seconds', async () => {
		vi.useFakeTimers();
		const writeText = vi.fn(() => Promise.resolve());
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		const w = mountPreviewer({ plainText: 'Hi' });

		await exportButton(w).trigger('click');
		await menuItem(w, 'Copy HTML')!.trigger('click');
		await flushPromises();
		expect(writeText).toHaveBeenCalledWith(HTML);
		expect(w.find('.ep-export-menu').exists()).toBe(false);

		await exportButton(w).trigger('click');
		expect(menuItem(w, 'Copy HTML')!.find('.ep-export-check').exists()).toBe(true);
		await vi.advanceTimersByTimeAsync(2000);
		expect(menuItem(w, 'Copy HTML')!.find('.ep-export-check').exists()).toBe(false);
	});

	it('offers the text body only when there is one', async () => {
		const w = mountPreviewer();
		await exportButton(w).trigger('click');
		expect(menuItem(w, 'Copy Plain Text')).toBeUndefined();
		expect(menuItem(w, 'Download .txt')).toBeUndefined();
		await w.setProps({ plainText: 'Hi' });
		expect(menuItem(w, 'Copy Plain Text')).toBeDefined();
		expect(menuItem(w, 'Download .txt')).toBeDefined();
	});

	it('closes on a click outside the menu', async () => {
		const w = mountPreviewer();
		await exportButton(w).trigger('click');
		expect(w.find('.ep-export-menu').exists()).toBe(true);
		await w.find('.ep-toolbar').trigger('click');
		expect(w.find('.ep-export-menu').exists()).toBe(false);
	});
});

describe('EmailPreviewer — Text view', () => {
	it('starts a manual body from the unfilled text and goes back to the generated one', async () => {
		const w = mountPreviewer({
			plainText: 'Hi Alex',
			plainTextSource: 'Hi {{firstName}}',
			allowPlainTextOverride: true,
		});
		await viewButton(w, 'Text').trigger('click');
		expect(w.find('pre.ep-plaintext-block').text()).toBe('Hi Alex');

		await w.find('.ep-plaintext-action').trigger('click');
		expect(w.emitted('update:plain-text-override')?.at(-1)).toEqual(['Hi {{firstName}}']);
		const editor = w.find<HTMLTextAreaElement>('textarea.ep-plaintext-editor');
		expect(editor.element.value).toBe('Hi {{firstName}}');

		await editor.setValue('Hello {{firstName}}');
		expect(w.emitted('update:plain-text-override')?.at(-1)).toEqual(['Hello {{firstName}}']);

		await w.find('.ep-plaintext-action').trigger('click');
		expect(w.emitted('update:plain-text-override')?.at(-1)).toEqual(['']);
		expect(w.find('textarea').exists()).toBe(false);
	});

	it('opens a stored manual body straight in the editor', async () => {
		const w = mountPreviewer({
			plainText: 'Hi Alex',
			plainTextOverride: 'Custom body',
			allowPlainTextOverride: true,
		});
		await viewButton(w, 'Text').trigger('click');
		expect(w.find<HTMLTextAreaElement>('textarea').element.value).toBe('Custom body');
	});
});

describe('EmailPreviewer — warnings and subject', () => {
	it('lists the render warnings from the badge and closes them', async () => {
		const w = mountPreviewer({ renderWarnings: ['First warning', 'Second warning'] });
		expect(w.find('.ep-warnings-panel').exists()).toBe(false);
		await w.find('.ep-warning-badge').trigger('click');
		expect(w.findAll('.ep-warnings-item').map((i) => i.text())).toEqual([
			'First warning',
			'Second warning',
		]);
		await w.find('.ep-warnings-close').trigger('click');
		expect(w.find('.ep-warnings-panel').exists()).toBe(false);
	});

	it('shows the subject and preheader under the preview', () => {
		const w = mountPreviewer({ subject: 'Hello', preheader: 'A short teaser' });
		expect(w.find('.ep-meta-preview').text()).toContain('Hello');
		expect(w.find('.ep-meta-preheader').text()).toBe('A short teaser');
	});
});
