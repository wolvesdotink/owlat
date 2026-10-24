/**
 * The page outlet puts the page boundary inside NuxtPage, around the page
 * component, and only under the dashboard shell: a standalone page keeps
 * sending its render failures on to Nuxt's full-page error screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, type Component } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ShellPageBoundaryKey } from '~/lib/pageBoundary';
import AppErrorBoundary from '../AppErrorBoundary.vue';
import AppPageOutlet from '../AppPageOutlet.vue';

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

const FailingPage = defineComponent({
	setup: () => () => {
		throw new Error('page could not render');
	},
});

const HealthyPage = defineComponent({
	setup: () => () => h('p', { 'data-testid': 'page' }, 'page'),
});

/** NuxtPage hands its slot the matched page as a vnode, like RouterView does. */
function nuxtPageStub(page: Component) {
	return defineComponent({
		name: 'NuxtPage',
		setup:
			(_props, { slots }) =>
			() =>
				slots.default?.({ Component: h(page) }),
	});
}

let lastAppErrorHandler: ReturnType<typeof vi.fn> | null = null;

async function mountOutlet(page: Component, inShell: boolean) {
	const appErrorHandler = vi.fn();
	lastAppErrorHandler = appErrorHandler;
	wrapper = mount(defineComponent({ setup: () => () => h('main', [h(AppPageOutlet)]) }), {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { NuxtPage: nuxtPageStub(page) },
			provide: inShell
				? { ['owlat:shell-page-boundary' satisfies ShellPageBoundaryKey]: AppErrorBoundary }
				: {},
			config: { errorHandler: appErrorHandler },
		},
	});
	await nextTick();
	return { wrapper, appErrorHandler };
}

describe('AppPageOutlet', () => {
	it('renders the page itself', async () => {
		const { wrapper } = await mountOutlet(HealthyPage, true);
		expect(wrapper.find('[data-testid="page"]').exists()).toBe(true);
	});

	it('contains a failing page under the shell', async () => {
		const { wrapper, appErrorHandler } = await mountOutlet(FailingPage, true);
		expect(wrapper.find('[role="alert"]').text()).toContain("This page couldn't be displayed.");
		expect(appErrorHandler).not.toHaveBeenCalled();
	});

	it('leaves a standalone page to the app error handler', async () => {
		// Test utils rethrow an error the app handler saw during mount.
		await expect(mountOutlet(FailingPage, false)).rejects.toThrow('page could not render');
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(lastAppErrorHandler).toHaveBeenCalledTimes(1);
	});
});
