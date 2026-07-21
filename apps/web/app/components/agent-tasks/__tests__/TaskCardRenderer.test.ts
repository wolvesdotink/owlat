// @vitest-environment happy-dom
/**
 * The task-card dispatcher's safety contract: a registered, enabled plugin kind
 * mounts its lazy card; a disabled or unknown kind degrades to the graceful
 * placeholder; and a plugin card that fails to LOAD or throws while RENDERING is
 * caught at the boundary and collapsed to the placeholder — a broken plugin can
 * never crash or empty the flow. Every branch stays skippable.
 */
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

import TaskCardRenderer from '../TaskCardRenderer.vue';
import { createTaskCardRegistry } from '~/utils/taskCardRegistry';

const stubs = {
	Icon: { template: '<i />' },
	UiIconBox: { template: '<i />' },
	UiSpinner: { template: '<i />' },
};

function mountRenderer(props: Record<string, unknown>) {
	// isFlagEnabled is a required prop (fail-closed); default it to "on" here so
	// each test only overrides it when exercising the gate.
	return mount(TaskCardRenderer, {
		props: { isFlagEnabled: () => true, ...props },
		global: { stubs },
	});
}

const fallbackSel = '[data-testid="task-fallback-skip"]';

describe('TaskCardRenderer', () => {
	it('falls back for an unknown (unregistered) kind and stays skippable', async () => {
		const registry = createTaskCardRegistry();
		const wrapper = mountRenderer({ kind: 'plugin.ghost', registry });
		expect(wrapper.find(fallbackSel).exists()).toBe(true);
		await wrapper.find(fallbackSel).trigger('click');
		expect(wrapper.emitted('skip')).toHaveLength(1);
	});

	it('falls back for a flag-disabled plugin kind', () => {
		const registry = createTaskCardRegistry();
		registry.register({
			kind: 'plugin.acme.gated',
			label: 'Gated',
			flag: 'plugin.acme',
			load: async () => ({ default: { template: '<div />' } }),
		});
		const wrapper = mountRenderer({
			kind: 'plugin.acme.gated',
			registry,
			isFlagEnabled: () => false,
		});
		expect(wrapper.find(fallbackSel).exists()).toBe(true);
		expect(wrapper.text()).toContain('Gated is turned off');
	});

	it('mounts an enabled plugin card and forwards its skip/complete emits', async () => {
		const PluginCard = defineComponent({
			props: { item: { type: Object, default: null } },
			emits: ['skip', 'complete'],
			setup(_, { emit }) {
				return () =>
					h('div', { 'data-testid': 'plugin-card' }, [
						h('button', { 'data-testid': 'p-skip', onClick: () => emit('skip') }, 'skip'),
						h(
							'button',
							{ 'data-testid': 'p-done', onClick: () => emit('complete', 'handled') },
							'done'
						),
					]);
			},
		});
		const registry = createTaskCardRegistry();
		registry.register({
			kind: 'plugin.acme.card',
			label: 'Card',
			flag: 'plugin.acme',
			load: async () => ({ default: PluginCard }),
		});

		const wrapper = mountRenderer({ kind: 'plugin.acme.card', registry, item: { id: 'x' } });
		await flushPromises();

		expect(wrapper.find('[data-testid="plugin-card"]').exists()).toBe(true);
		await wrapper.find('[data-testid="p-skip"]').trigger('click');
		await wrapper.find('[data-testid="p-done"]').trigger('click');
		expect(wrapper.emitted('skip')).toHaveLength(1);
		expect(wrapper.emitted('complete')).toEqual([['handled']]);
	});

	it('collapses to the placeholder when the plugin card fails to load', async () => {
		const registry = createTaskCardRegistry();
		registry.register({
			kind: 'plugin.acme.broken',
			label: 'Broken',
			flag: 'plugin.acme',
			load: async () => {
				throw new Error('bundle 500');
			},
		});
		// Vue logs the async load rejection; keep the test output clean.
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const wrapper = mountRenderer({ kind: 'plugin.acme.broken', registry });
		await flushPromises();
		await flushPromises();

		expect(wrapper.find(fallbackSel).exists()).toBe(true);
		errSpy.mockRestore();
		warnSpy.mockRestore();
	});

	it('collapses to the placeholder when the plugin card throws while rendering', async () => {
		const Throwing = defineComponent({
			setup() {
				throw new Error('render boom');
			},
		});
		const registry = createTaskCardRegistry();
		registry.register({
			kind: 'plugin.acme.throws',
			label: 'Throws',
			flag: 'plugin.acme',
			load: async () => ({ default: Throwing }),
		});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const wrapper = mountRenderer({ kind: 'plugin.acme.throws', registry });
		await flushPromises();
		await flushPromises();

		expect(wrapper.find(fallbackSel).exists()).toBe(true);
		errSpy.mockRestore();
		warnSpy.mockRestore();
	});
});
