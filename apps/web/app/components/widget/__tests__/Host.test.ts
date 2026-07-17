// @vitest-environment happy-dom
/**
 * WidgetHost is the isolation boundary every panel/widget contribution renders
 * through. These tests pin the guarantees the whole registry leans on:
 *   - a contribution that throws is caught and replaced by an accessible
 *     fallback, and the error does NOT propagate up to crash the page;
 *   - the widget mounts lazily behind a loading state;
 *   - typed context is forwarded to the contribution, and omitted context binds
 *     no stray attribute (so existing context-free cards render unchanged);
 *   - the rendered widget is an accessible, labelled region.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, markRaw, onErrorCaptured, type Component } from 'vue';
import WidgetHost from '../Host.vue';
import type { WidgetModule } from '~/composables/widgets/types';

/** Build a module from a raw component loader (mirrors the `() => import()` shape). */
function moduleForLoader(
	component: WidgetModule['component'],
	extra: Partial<WidgetModule> = {}
): WidgetModule {
	return { kind: 'sample', label: 'Sample Widget', source: 'core', component, ...extra };
}

/** Build a module whose loader resolves synchronously to the given component. */
function moduleFor(component: Component, extra: Partial<WidgetModule> = {}): WidgetModule {
	return moduleForLoader(() => Promise.resolve(component), extra);
}

const mountOpts = { global: { stubs: { Icon: true } } };

afterEach(() => {
	vi.restoreAllMocks();
});

describe('WidgetHost — rendering & accessibility', () => {
	it('renders the contribution inside a labelled region', async () => {
		const Child = defineComponent({ template: '<div data-testid="child">card body</div>' });
		const wrapper = mount(WidgetHost, {
			...mountOpts,
			props: { module: moduleFor(Child) },
		});
		await flushPromises();

		const region = wrapper.find('[role="region"]');
		expect(region.exists()).toBe(true);
		expect(region.attributes('aria-label')).toBe('Sample Widget');
		expect(wrapper.find('[data-testid="child"]').text()).toBe('card body');
	});

	it('falls back to the widget kind when no label is present', async () => {
		const Child = defineComponent({ template: '<div />' });
		const wrapper = mount(WidgetHost, {
			...mountOpts,
			props: { module: moduleFor(Child, { label: undefined, kind: 'raw_kind' }) },
		});
		await flushPromises();
		expect(wrapper.find('[role="region"]').attributes('aria-label')).toBe('raw_kind');
	});
});

describe('WidgetHost — typed context', () => {
	it('forwards a typed context object to the contribution', async () => {
		const Child = defineComponent({
			props: { context: { type: Object, default: null } },
			setup: (props) => () => h('div', { 'data-testid': 'ctx' }, props.context?.threadId),
		});
		const wrapper = mount(WidgetHost, {
			...mountOpts,
			props: { module: moduleFor(Child), context: { threadId: 't-42' } },
		});
		await flushPromises();
		expect(wrapper.find('[data-testid="ctx"]').text()).toBe('t-42');
	});

	it('binds no stray context attribute when no context is given', async () => {
		const Child = defineComponent({ template: '<div data-testid="plain">hi</div>' });
		const wrapper = mount(WidgetHost, {
			...mountOpts,
			props: { module: moduleFor(Child) },
		});
		await flushPromises();
		expect(wrapper.get('[data-testid="plain"]').attributes('context')).toBeUndefined();
	});
});

describe('WidgetHost — lazy loading', () => {
	it('shows a busy state before the async chunk resolves, then the content', async () => {
		let resolveChunk!: (component: Component) => void;
		const wrapper = mount(WidgetHost, {
			...mountOpts,
			props: {
				module: moduleForLoader(
					() => new Promise<Component>((resolve) => (resolveChunk = resolve))
				),
			},
		});

		expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);

		resolveChunk(defineComponent({ template: '<div data-testid="async">loaded</div>' }));
		await flushPromises();

		expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="async"]').text()).toBe('loaded');
	});
});

describe('WidgetHost — isolation (error boundary)', () => {
	it('catches a throwing contribution and shows an alert fallback', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const Boom = defineComponent({
			setup() {
				throw new Error('boom');
			},
			template: '<div />',
		});

		const wrapper = mount(WidgetHost, {
			...mountOpts,
			props: { module: moduleFor(Boom, { kind: 'broken' }) },
		});
		await flushPromises();

		const alert = wrapper.find('[role="alert"]');
		expect(alert.exists()).toBe(true);
		expect(alert.text()).toContain('hidden to keep the rest of the page working');
		expect(errorSpy).toHaveBeenCalled();
	});

	it('does not let the error propagate to an outer boundary (page survives)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const outerCaptured = vi.fn();
		const Boom = defineComponent({
			setup() {
				throw new Error('boom');
			},
			template: '<div />',
		});
		const brokenModule = moduleFor(markRaw(Boom), { kind: 'broken' });
		const Parent = defineComponent({
			components: { WidgetHost },
			setup() {
				onErrorCaptured(() => {
					outerCaptured();
					return false;
				});
				return { module: brokenModule };
			},
			// A sibling that must keep rendering even though the widget blew up.
			template:
				'<div><span data-testid="sibling">alive</span><WidgetHost :module="module" /></div>',
		});

		const wrapper = mount(Parent, mountOpts);
		await flushPromises();

		expect(outerCaptured).not.toHaveBeenCalled();
		expect(wrapper.find('[data-testid="sibling"]').text()).toBe('alive');
		expect(wrapper.find('[role="alert"]').exists()).toBe(true);
	});

	it('clears the error and re-attempts the widget on retry', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let shouldThrow = true;
		const Flaky = defineComponent({
			setup() {
				if (shouldThrow) throw new Error('boom');
			},
			template: '<div data-testid="recovered">ok</div>',
		});

		const wrapper = mount(WidgetHost, {
			...mountOpts,
			props: { module: moduleFor(Flaky, { kind: 'flaky' }) },
		});
		await flushPromises();
		expect(wrapper.find('[role="alert"]').exists()).toBe(true);

		shouldThrow = false;
		await wrapper.find('[role="alert"] button').trigger('click');
		await flushPromises();

		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="recovered"]').exists()).toBe(true);
	});

	it('re-fetches a failed chunk load on retry (recovers a rejected loader)', async () => {
		// The realistic failure: a chunk 404 after a redeploy. Vue's
		// defineAsyncComponent caches a rejected loader promise, so recovery
		// requires WidgetHost to build a fresh wrapper — this fails on any impl
		// that reuses one constructed async component across retries.
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const Recovered = defineComponent({
			template: '<div data-testid="lazy-recovered">ok</div>',
		});
		const loader = vi
			.fn<[], Promise<Component>>()
			.mockRejectedValueOnce(new Error('chunk load failed'))
			.mockResolvedValue(Recovered);

		const wrapper = mount(WidgetHost, {
			...mountOpts,
			props: { module: moduleForLoader(loader, { kind: 'lazy_flaky' }) },
		});
		await flushPromises();

		expect(wrapper.find('[role="alert"]').exists()).toBe(true);
		expect(loader).toHaveBeenCalledTimes(1);

		await wrapper.find('[role="alert"] button').trigger('click');
		await flushPromises();

		expect(loader).toHaveBeenCalledTimes(2);
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="lazy-recovered"]').exists()).toBe(true);
	});
});

describe('WidgetHost — focus management on retry', () => {
	it('keeps focus inside the region after a successful retry', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let shouldThrow = true;
		const Flaky = defineComponent({
			setup() {
				if (shouldThrow) throw new Error('boom');
			},
			template: '<div data-testid="ok">ok</div>',
		});
		const wrapper = mount(WidgetHost, {
			attachTo: document.body,
			...mountOpts,
			props: { module: moduleFor(Flaky, { kind: 'flaky' }) },
		});
		await flushPromises();

		shouldThrow = false;
		await wrapper.find('[role="alert"] button').trigger('click');
		await flushPromises();

		// The button that held focus is gone; focus must not have fallen to <body>.
		const region = wrapper.get('[role="region"]').element;
		expect(region.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).not.toBe(document.body);
		wrapper.unmount();
	});

	it('keeps focus inside the region when the retry fails again', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const Boom = defineComponent({
			setup() {
				throw new Error('boom');
			},
			template: '<div />',
		});
		const wrapper = mount(WidgetHost, {
			attachTo: document.body,
			...mountOpts,
			props: { module: moduleFor(Boom, { kind: 'broken' }) },
		});
		await flushPromises();

		await wrapper.find('[role="alert"] button').trigger('click');
		await flushPromises();

		// A new alert is shown, and focus is still inside the region (not <body>).
		expect(wrapper.find('[role="alert"]').exists()).toBe(true);
		const region = wrapper.get('[role="region"]').element;
		expect(region.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).not.toBe(document.body);
		wrapper.unmount();
	});
});
