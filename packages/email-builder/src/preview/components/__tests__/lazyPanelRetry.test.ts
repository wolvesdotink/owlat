// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, onErrorCaptured, type Component } from 'vue';
import { createI18n } from 'vue-i18n';
import uiEn from '@owlat/ui/i18n/locales/en.json';
import uiDe from '@owlat/ui/i18n/locales/de.json';
import { lazyPanel } from '../lazyPanels';

/**
 * A preview panel whose chunk fails to load (plan item OW-060) shows a failure
 * in its place and can try again; the failure never reaches an ancestor's
 * errorCaptured, where the web editor's error boundary would replace the whole
 * editor with its fallback.
 */
const Panel = defineComponent({
	props: { note: { type: String, default: '' } },
	setup: (props) => () => h('div', { class: 'real-panel' }, props.note),
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

/** Mounts the lazy panel under a host that records anything raised to it. */
function mountUnderHost(Lazy: Component, locale?: 'en' | 'de') {
	const captured = vi.fn(() => false);
	const Host = defineComponent({
		setup() {
			onErrorCaptured(captured);
			return () => h('div', [h(Lazy, { note: 'loaded' })]);
		},
	});
	const plugins = locale
		? [
				createI18n({
					legacy: false,
					locale,
					fallbackLocale: 'en',
					messages: { en: structuredClone(uiEn), de: structuredClone(uiDe) },
				}),
			]
		: [];
	wrapper = mount(Host, { global: { plugins } });
	return { w: wrapper, captured };
}

/** What a dynamic import resolves to; Vue unwraps `default` only from a module. */
const asModule = (component: Component) => ({ __esModule: true, default: component });
const chunkError = () => new TypeError('Failed to fetch dynamically imported module');

describe('lazyPanel — failure and retry', () => {
	it('renders the real panel once a retry succeeds', async () => {
		const loader = vi
			.fn<() => Promise<{ default: Component }>>()
			.mockRejectedValueOnce(chunkError())
			.mockResolvedValue(asModule(Panel));
		const { w, captured } = mountUnderHost(lazyPanel(loader));
		await flushPromises();

		const failed = w.find('.ep-panel-loading');
		expect(failed.attributes('role')).toBe('alert');
		expect(failed.text()).toContain('Something went wrong. Please try again.');
		// The panel's props do not leak onto the stand-in as attributes.
		expect(failed.attributes('note')).toBeUndefined();

		await failed.find('button').trigger('click');
		await flushPromises();

		expect(loader).toHaveBeenCalledTimes(2);
		expect(w.find('.ep-panel-loading').exists()).toBe(false);
		expect(w.find('.real-panel').text()).toBe('loaded');
		expect(captured).not.toHaveBeenCalled();
	});

	it('stays contained when the retry fails again', async () => {
		const loader = vi.fn<() => Promise<{ default: Component }>>().mockRejectedValue(chunkError());
		const { w, captured } = mountUnderHost(lazyPanel(loader));
		await flushPromises();

		await w.find('.ep-panel-loading button').trigger('click');
		await flushPromises();

		expect(loader).toHaveBeenCalledTimes(2);
		expect(w.find('.ep-panel-loading').attributes('role')).toBe('alert');
		expect(w.find('.ep-panel-loading button').text()).toBe('Try again');
		expect(captured).not.toHaveBeenCalled();
	});

	it('keeps focus on Try again when the retry fails again', async () => {
		const loader = vi.fn<() => Promise<{ default: Component }>>().mockRejectedValue(chunkError());
		const Lazy = lazyPanel(loader);
		wrapper = mount(Lazy, { attachTo: document.body });
		await flushPromises();
		// A first failure does not take focus: nobody asked for the panel to load.
		expect(document.activeElement).toBe(document.body);

		const first = wrapper.find<HTMLButtonElement>('.ep-panel-loading button');
		first.element.focus();
		await first.trigger('click');
		await flushPromises();

		const again = wrapper.find<HTMLButtonElement>('.ep-panel-loading button');
		expect(again.element).not.toBe(first.element);
		expect(document.activeElement).toBe(again.element);
	});

	it('offers nothing that reloads the host page', async () => {
		const loader = vi.fn<() => Promise<{ default: Component }>>().mockRejectedValue(chunkError());
		const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
		try {
			const { w } = mountUnderHost(lazyPanel(loader));
			await flushPromises();
			for (const button of w.findAll('button')) await button.trigger('click');
			await flushPromises();
			expect(reload).not.toHaveBeenCalled();
		} finally {
			reload.mockRestore();
		}
	});

	it('speaks German in a German app', async () => {
		const loader = vi
			.fn<() => Promise<{ default: Component }>>()
			.mockImplementation(() => new Promise(() => {}));
		vi.useFakeTimers();
		try {
			const slow = mountUnderHost(lazyPanel(loader), 'de');
			await vi.advanceTimersByTimeAsync(250);
			const loading = slow.w.find('.ep-panel-loading');
			expect(loading.attributes('role')).toBe('status');
			expect(loading.text()).toBe('Wird geladen…');
		} finally {
			vi.useRealTimers();
		}
		wrapper?.unmount();

		const failing = vi.fn<() => Promise<{ default: Component }>>().mockRejectedValue(chunkError());
		const { w } = mountUnderHost(lazyPanel(failing), 'de');
		await flushPromises();
		const failed = w.find('.ep-panel-loading');
		expect(failed.text()).toContain('Etwas ist schiefgelaufen. Bitte versuche es erneut.');
		expect(failed.find('button').text()).toBe('Erneut versuchen');
	});

	it('hides the decorative icons from assistive technology', async () => {
		const loader = vi.fn<() => Promise<{ default: Component }>>().mockRejectedValue(chunkError());
		const { w } = mountUnderHost(lazyPanel(loader));
		await flushPromises();
		const icons = w.findAll('.ep-panel-loading svg');
		expect(icons.length).toBeGreaterThan(0);
		for (const icon of icons) expect(icon.attributes('aria-hidden')).toBe('true');
	});
});
