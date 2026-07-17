// @vitest-environment happy-dom
/**
 * The flow-level wiring both focused flows use for a plugin card: the card's
 * `complete` emit is bound to `flow.complete(current.id, { outcome })`, so a
 * plugin card that finishes its work actually advances the flow, records an
 * outcome in the end-state tally, and enters the undo stack — it is not dropped.
 * A completion with no explicit outcome falls back to `'completed'`.
 *
 * TaskCardRenderer + useTaskFlow are both Convex-free, so this mounts them
 * composed exactly as ReviewFocusFlow / PostboxReplyFlow compose them, without
 * the heavy flow shells.
 */
import { describe, it, expect } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

import TaskCardRenderer from '../TaskCardRenderer.vue';
import { useTaskFlow } from '~/composables/useTaskFlow';
import { createTaskCardRegistry } from '~/utils/taskCardRegistry';
import type { TaskFlowKind, TaskFlowOrderKey } from '~/utils/taskFlow';

const stubs = { Icon: { template: '<i />' }, UiIconBox: { template: '<i />' } };

// A plugin card that reports completion — with and without an explicit outcome.
const PluginCard = defineComponent({
	emits: ['complete', 'skip'],
	setup(_, { emit }) {
		return () =>
			h('div', [
				h('button', { 'data-testid': 'done', onClick: () => emit('complete', 'handled') }, 'done'),
				h('button', { 'data-testid': 'done-bare', onClick: () => emit('complete') }, 'bare'),
			]);
	},
});

interface Item {
	id: string;
	kind: TaskFlowKind;
}
const key = (i: Item): TaskFlowOrderKey => i;

function mountWired(source: Item[]) {
	const registry = createTaskCardRegistry();
	registry.register({
		kind: 'plugin.acme.card',
		label: 'Card',
		load: async () => ({ default: PluginCard }),
	});

	const Harness = defineComponent({
		components: { TaskCardRenderer },
		setup() {
			const flow = useTaskFlow(ref(source), { key });
			flow.start();
			const onComplete = (outcome?: string) =>
				flow.complete(flow.currentId.value!, { outcome: outcome ?? 'completed' });
			const onSkip = () => flow.skip(flow.currentId.value!);
			const alwaysOn = () => true;
			return { flow, registry, onComplete, onSkip, alwaysOn };
		},
		template: `<TaskCardRenderer
			v-if="flow.current.value"
			:kind="flow.current.value.kind"
			:item="flow.current.value"
			:registry="registry"
			:is-flag-enabled="alwaysOn"
			@complete="onComplete"
			@skip="onSkip"
		/>`,
	});
	return mount(Harness, { global: { stubs } });
}

describe('plugin-card complete wiring', () => {
	it('advances the flow and tallies the outcome when a plugin card completes', async () => {
		const wrapper = mountWired([
			{ id: 'a', kind: 'plugin.acme.card' },
			{ id: 'b', kind: 'plugin.acme.card' },
		]);
		await flushPromises();
		const { flow } = wrapper.vm as unknown as { flow: ReturnType<typeof useTaskFlow<Item>> };
		expect(flow.currentId.value).toBe('a');

		await wrapper.find('[data-testid="done"]').trigger('click');
		await flushPromises();
		// Advanced to the next card, and the outcome was tallied + undoable.
		expect(flow.currentId.value).toBe('b');
		expect(flow.summary.value).toBe('1 handled');
		expect(flow.canUndo.value).toBe(true);
	});

	it("defaults a bare complete (no outcome) to 'completed'", async () => {
		const wrapper = mountWired([{ id: 'a', kind: 'plugin.acme.card' }]);
		await flushPromises();
		const { flow } = wrapper.vm as unknown as { flow: ReturnType<typeof useTaskFlow<Item>> };

		await wrapper.find('[data-testid="done-bare"]').trigger('click');
		await flushPromises();
		expect(flow.isComplete.value).toBe(true);
		expect(flow.summary.value).toBe('1 completed');
	});
});
