// @vitest-environment happy-dom
/**
 * The app's pane boundary. On top of the shared UiErrorBoundary it has to:
 *   - name the pane that failed, in the reader's language;
 *   - recover on navigation (the route is always a reset key) and on the
 *     pane's own keys;
 *   - contain only render failures: a throwing click handler leaves the pane on
 *     screen and goes to the app's error handler (its toast) as before;
 *   - report what it contained to diagnostics without a toast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, reactive, ref, type Ref } from 'vue';
import { routeLocationKey } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { clientErrorReporterKey } from '~/lib/clientErrorReporter';
import AppErrorBoundary from '../AppErrorBoundary.vue';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	vi.restoreAllMocks();
});

/** Renders a button; throws from render while `failing` is true, from its click always. */
function pane(failing: Ref<boolean>) {
	return defineComponent({
		setup: () => () => {
			if (failing.value) throw new Error('pane could not render');
			return h(
				'button',
				{
					'data-testid': 'pane',
					onClick: () => {
						throw new Error('click handler failed');
					},
				},
				'pane'
			);
		},
	});
}

function mountBoundary(
	failing: Ref<boolean>,
	options: { resetKeys?: Ref<unknown[]>; i18n?: ReturnType<typeof createTestI18n> } = {}
) {
	const route = reactive({ fullPath: '/dashboard/postbox/inbox/m1' });
	const report = vi.fn();
	const appErrorHandler = vi.fn();
	const Pane = pane(failing);
	const Host = defineComponent({
		setup: () => () =>
			h('div', [
				h('nav', { 'data-testid': 'shell' }, 'shell'),
				h(
					AppErrorBoundary,
					{ surface: 'composer', resetKeys: options.resetKeys?.value },
					{ default: () => h(Pane) }
				),
			]),
	});
	wrapper = mount(Host, {
		attachTo: document.body,
		global: {
			plugins: [options.i18n ?? createTestI18n()],
			provide: { [routeLocationKey as symbol]: route, [clientErrorReporterKey as symbol]: report },
			config: { errorHandler: appErrorHandler },
		},
	});
	return { wrapper, route, report, appErrorHandler };
}

describe('AppErrorBoundary', () => {
	it('says which pane failed, keeps the shell, and reports without the app handler', async () => {
		const { wrapper, report, appErrorHandler } = mountBoundary(ref(true));
		await nextTick();

		const alert = wrapper.get('[role="alert"]');
		expect(alert.text()).toContain(en.shell.paneError.composer);
		expect(alert.text()).toContain(en.shell.paneError.detail);
		expect(wrapper.get('[data-testid="shell"]').text()).toBe('shell');

		expect(report).toHaveBeenCalledTimes(1);
		expect((report.mock.calls[0]![0] as Error).message).toBe('pane could not render');
		expect(report.mock.calls[0]![1]).toBe('boundary:composer:render function');
		expect(appErrorHandler).not.toHaveBeenCalled();
	});

	it('renders the German copy under the German catalog', async () => {
		const german = createI18n({ legacy: false, locale: 'de', messages: { de, en } });
		const { wrapper } = mountBoundary(ref(true), {
			i18n: german as unknown as ReturnType<typeof createTestI18n>,
		});
		await nextTick();
		expect(wrapper.get('[role="alert"]').text()).toContain(de.shell.paneError.composer);
	});

	it('recovers when the route changes', async () => {
		const failing = ref(true);
		const { wrapper, route } = mountBoundary(failing);
		await nextTick();

		failing.value = false;
		route.fullPath = '/dashboard/postbox/inbox/m2';
		await nextTick();

		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="pane"]').exists()).toBe(true);
	});

	it('recovers when one of its own reset keys changes, with the route unchanged', async () => {
		const failing = ref(true);
		const resetKeys = ref<unknown[]>(['draft-1']);
		const { wrapper } = mountBoundary(failing, { resetKeys });
		await nextTick();

		failing.value = false;
		resetKeys.value = ['draft-2'];
		await nextTick();

		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
	});

	it('leaves a pane whose click handler throws on screen and hands the error on', async () => {
		const { wrapper, report, appErrorHandler } = mountBoundary(ref(false));

		await wrapper.get('[data-testid="pane"]').trigger('click');

		expect(appErrorHandler).toHaveBeenCalledTimes(1);
		expect((appErrorHandler.mock.calls[0]![0] as Error).message).toBe('click handler failed');
		expect(report).not.toHaveBeenCalled();
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="pane"]').exists()).toBe(true);
	});

	it('works without a router or the error plugin', async () => {
		const Pane = pane(ref(true));
		wrapper = mount(AppErrorBoundary, {
			props: { surface: 'reader' },
			slots: { default: () => h(Pane) },
			global: { plugins: [createTestI18n()] },
		});
		await nextTick();
		expect(wrapper.get('[role="alert"]').text()).toContain(en.shell.paneError.reader);
	});
});
