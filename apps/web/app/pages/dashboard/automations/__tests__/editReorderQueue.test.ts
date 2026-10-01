// @vitest-environment happy-dom
/**
 * Reorders made while an earlier one is still being saved.
 *
 * The page and the real `useAutomationSteps` run here; only the reorder
 * mutation is held open, so a test decides when each save returns and when
 * the server's echo arrives. Whatever the route (menu, keyboard, drag), the
 * last order saved must be the order on screen, and an echo of an earlier save
 * must not move the list back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { useAutomationSteps } from '~/composables/useAutomationSteps';
import {
	mountEditPage,
	stubEditPage,
	type EditPageWrapper,
	type HarnessStep,
} from './editPageHarness';

type HeldSave = { stepOrder: string[]; settle: (ok: boolean) => void };

function stubHeldReorder() {
	const harness = stubEditPage();
	const saves: HeldSave[] = [];
	const settled = new Set<HeldSave>();
	vi.stubGlobal('useAutomationSteps', useAutomationSteps);
	vi.stubGlobal('useBackendOperation', (reference: FunctionReference<'mutation'>) => ({
		run:
			getFunctionName(reference) === 'automations/steps:reorderSteps'
				? (args: { stepOrder: string[] }) =>
						new Promise((resolve) => {
							saves.push({
								stepOrder: args.stepOrder,
								settle: (ok) => resolve(ok ? { ok: true, result: null } : { ok: false }),
							});
						})
				: vi.fn(() => Promise.resolve({ ok: true, result: null })),
		isLoading: ref(false),
		inlineError: ref(null),
	}));
	/** The server's echo: the steps as stored, in `ids` order. */
	const echo = (ids: string[]) => {
		const byId = new Map(harness.data.value.steps.map((step) => [step._id, step]));
		harness.data.value = {
			...harness.data.value,
			steps: ids.map((id) => ({ ...byId.get(id)! })) as HarnessStep[],
		};
	};
	/** Settle the oldest outstanding save; on success the echo lands first. */
	const settle = async (ok = true) => {
		const save = saves.find((entry) => !settled.has(entry))!;
		settled.add(save);
		if (ok) echo(save.stepOrder);
		save.settle(ok);
		await flushPromises();
	};
	const outstanding = () => saves.filter((entry) => !settled.has(entry));
	return { ...harness, saves, echo, settle, outstanding };
}

const order = (wrapper: EditPageWrapper) =>
	wrapper.findAll('[data-step-title]').map((title) => title.attributes('data-step-title'));
const menuItem = (wrapper: EditPageWrapper, id: string, label: string) => {
	const card = wrapper
		.findAll('[data-testid="automation-step"]')
		.find((entry) => entry.find(`[data-step-title="${id}"]`).exists())!;
	return card.findAll('[role="menuitem"]').find((item) => item.text() === label)!;
};
const moveDown = async (wrapper: EditPageWrapper, id: string) => {
	await menuItem(wrapper, id, 'Move down').trigger('click');
	await flushPromises();
};
const press = async (wrapper: EditPageWrapper, id: string, key: string) => {
	await wrapper.get(`[data-step-handle="${id}"]`).trigger('keydown', { key });
	await flushPromises();
};
const keyboardMoveDown = async (wrapper: EditPageWrapper, id: string) => {
	await press(wrapper, id, ' ');
	await press(wrapper, id, 'ArrowDown');
	await press(wrapper, id, ' ');
};

describe('reordering while a reorder is being saved', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('repeated Move down saves the order on screen, one save at a time', async () => {
		const { saves, settle, echo, outstanding } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await moveDown(wrapper, 'st_1');
		expect(order(wrapper)).toEqual(['st_2', 'st_1', 'st_3']);
		await moveDown(wrapper, 'st_1');
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);
		// The second move waits for the first save instead of racing it.
		expect(saves.map((save) => save.stepOrder)).toEqual([['st_2', 'st_1', 'st_3']]);

		// The first save's echo arrives: the list keeps the newer order.
		echo(['st_2', 'st_1', 'st_3']);
		await flushPromises();
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);

		await settle();
		expect(saves.map((save) => save.stepOrder)).toEqual([
			['st_2', 'st_1', 'st_3'],
			['st_2', 'st_3', 'st_1'],
		]);
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);

		await settle();
		expect(outstanding()).toHaveLength(0);
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);
		wrapper.unmount();
	});

	it('moves made during a save collapse into one save of the newest order', async () => {
		const { saves, settle } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await moveDown(wrapper, 'st_1');
		await moveDown(wrapper, 'st_1');
		await menuItem(wrapper, 'st_2', 'Move down').trigger('click');
		await flushPromises();
		expect(order(wrapper)).toEqual(['st_3', 'st_2', 'st_1']);

		await settle();
		await settle();
		expect(saves.map((save) => save.stepOrder)).toEqual([
			['st_2', 'st_1', 'st_3'],
			['st_3', 'st_2', 'st_1'],
		]);
		expect(order(wrapper)).toEqual(['st_3', 'st_2', 'st_1']);
		wrapper.unmount();
	});

	it('repeated keyboard drops save the order on screen', async () => {
		const { saves, settle, announce } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await keyboardMoveDown(wrapper, 'st_1');
		await keyboardMoveDown(wrapper, 'st_1');
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);

		await settle();
		await settle();
		expect(saves.map((save) => save.stepOrder)).toEqual([
			['st_2', 'st_1', 'st_3'],
			['st_2', 'st_3', 'st_1'],
		]);
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);
		// Announced once, for the drop that is now stored.
		expect(announce).toHaveBeenLastCalledWith('Step moved to position 3 of 3.');
		wrapper.unmount();
	});

	it('Escape during a save puts the step back where it was lifted, not the saved order', async () => {
		const { saves, settle } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await moveDown(wrapper, 'st_1');
		await press(wrapper, 'st_3', ' ');
		await press(wrapper, 'st_3', 'ArrowUp');
		await press(wrapper, 'st_3', 'Escape');
		expect(order(wrapper)).toEqual(['st_2', 'st_1', 'st_3']);

		await settle();
		expect(saves.map((save) => save.stepOrder)).toEqual([['st_2', 'st_1', 'st_3']]);
		expect(order(wrapper)).toEqual(['st_2', 'st_1', 'st_3']);
		wrapper.unmount();
	});

	it('a drag followed by a menu move saves the menu move on top of the drag', async () => {
		const { saves, settle } = stubHeldReorder();
		const wrapper = await mountEditPage();
		const draggable = wrapper.findComponent({ name: 'VueDraggable' });

		// SortableJS writes the dropped order through v-model, then fires `end`.
		const [first, second, third] = draggable.props('modelValue') as HarnessStep[];
		draggable.vm.$emit('update:modelValue', [third, first, second]);
		draggable.vm.$emit('end', { oldIndex: 2, newIndex: 0 });
		await flushPromises();
		expect(order(wrapper)).toEqual(['st_3', 'st_1', 'st_2']);

		await moveDown(wrapper, 'st_1');
		expect(order(wrapper)).toEqual(['st_3', 'st_2', 'st_1']);

		await settle();
		await settle();
		expect(saves.map((save) => save.stepOrder)).toEqual([
			['st_3', 'st_1', 'st_2'],
			['st_3', 'st_2', 'st_1'],
		]);
		expect(order(wrapper)).toEqual(['st_3', 'st_2', 'st_1']);
		wrapper.unmount();
	});

	it('a failed save shows the server order again and drops the queued move', async () => {
		const { saves, settle, outstanding } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await moveDown(wrapper, 'st_1');
		await moveDown(wrapper, 'st_1');
		await settle(false);

		expect(order(wrapper)).toEqual(['st_1', 'st_2', 'st_3']);
		expect(saves).toHaveLength(1);
		expect(outstanding()).toHaveLength(0);

		// The next move starts from the server order.
		await moveDown(wrapper, 'st_2');
		expect(saves.at(-1)!.stepOrder).toEqual(['st_1', 'st_3', 'st_2']);
		wrapper.unmount();
	});

	it('a failed queued save falls back to the order the first save stored', async () => {
		const { saves, settle } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await moveDown(wrapper, 'st_1');
		await moveDown(wrapper, 'st_1');
		await settle();
		await settle(false);

		expect(saves).toHaveLength(2);
		expect(order(wrapper)).toEqual(['st_2', 'st_1', 'st_3']);
		wrapper.unmount();
	});
});
