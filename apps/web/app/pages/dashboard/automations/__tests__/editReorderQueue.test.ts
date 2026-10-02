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
type HeldAdd = { insertAtIndex?: number; settle: () => Promise<void> };

function stubHeldReorder() {
	const harness = stubEditPage();
	const saves: HeldSave[] = [];
	const settled = new Set<HeldSave>();
	const adds: HeldAdd[] = [];
	vi.stubGlobal('useAutomationSteps', useAutomationSteps);
	const held = (name: string) => {
		if (name === 'automations/steps:reorderSteps') {
			return (args: { stepOrder: string[] }) =>
				new Promise((resolve) => {
					saves.push({
						stepOrder: args.stepOrder,
						settle: (ok) => resolve(ok ? { ok: true, result: null } : { ok: false }),
					});
				});
		}
		if (name === 'automations/steps:addStep') {
			// Settling inserts `st_new` where the server would: at `insertAtIndex`
			// of the order it holds, or at the end.
			return (args: { stepType: string; insertAtIndex?: number }) =>
				new Promise((resolve) => {
					adds.push({
						insertAtIndex: args.insertAtIndex,
						settle: async () => {
							const steps = [...harness.data.value.steps];
							const at = Math.min(args.insertAtIndex ?? steps.length, steps.length);
							steps.splice(at, 0, {
								_id: 'st_new',
								stepType: args.stepType,
								config: '{}',
							} as HarnessStep);
							harness.data.value = { ...harness.data.value, steps };
							resolve({ ok: true, result: 'st_new' });
							await flushPromises();
						},
					});
				});
		}
		return vi.fn(() => Promise.resolve({ ok: true, result: null }));
	};
	vi.stubGlobal('useBackendOperation', (reference: FunctionReference<'mutation'>) => ({
		run: held(getFunctionName(reference)),
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
	return { ...harness, saves, adds, echo, settle, outstanding };
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
/** Add a step through the "+" under the step at `index` on screen. */
const addStepAfter = async (wrapper: EditPageWrapper, index: number) => {
	const card = wrapper.findAll('[data-testid="automation-step"]')[index]!;
	await card.find('button[aria-label="Add"]').trigger('click');
	await wrapper.get('[data-testid="add-step-menu"] button').trigger('click');
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

/**
 * A lifted keyboard step is a preview. Only a drop commits it, so a save
 * queued earlier must never carry it, and anything that ends the lift without
 * a drop puts the committed order back.
 */
describe('keyboard previews and the reorder queue', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	const lifted = (wrapper: EditPageWrapper, id: string) =>
		wrapper.get(`[data-step-handle="${id}"]`).attributes('aria-pressed') === 'true';

	// Marcel's sequence: two queued menu moves, then an undropped keyboard move
	// while the first save is still out.
	const queueThenPreview = async () => {
		const harness = stubHeldReorder();
		const wrapper = await mountEditPage();
		await moveDown(wrapper, 'st_1');
		await moveDown(wrapper, 'st_1');
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);
		await press(wrapper, 'st_2', ' ');
		await press(wrapper, 'st_2', 'ArrowDown');
		expect(order(wrapper)).toEqual(['st_3', 'st_2', 'st_1']);
		return { ...harness, wrapper };
	};

	for (const key of ['Escape', 'Tab']) {
		it(`a queued save leaves out an undropped move cancelled with ${key}`, async () => {
			const { wrapper, saves, settle } = await queueThenPreview();

			await settle();
			// The queued save is the committed order, not the preview.
			expect(saves.map((save) => save.stepOrder)).toEqual([
				['st_2', 'st_1', 'st_3'],
				['st_2', 'st_3', 'st_1'],
			]);
			// The first save's echo and completion leave the preview alone.
			expect(order(wrapper)).toEqual(['st_3', 'st_2', 'st_1']);
			expect(lifted(wrapper, 'st_2')).toBe(true);

			await press(wrapper, 'st_2', key);
			expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);
			await settle();
			expect(saves).toHaveLength(2);
			expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);
			wrapper.unmount();
		});
	}

	it('a drop after a queued move saves the dropped order', async () => {
		const { wrapper, saves, settle } = await queueThenPreview();

		await settle();
		await press(wrapper, 'st_2', ' ');
		expect(order(wrapper)).toEqual(['st_3', 'st_2', 'st_1']);
		await settle();
		await settle();
		expect(saves.map((save) => save.stepOrder)).toEqual([
			['st_2', 'st_1', 'st_3'],
			['st_2', 'st_3', 'st_1'],
			['st_3', 'st_2', 'st_1'],
		]);
		expect(order(wrapper)).toEqual(['st_3', 'st_2', 'st_1']);
		wrapper.unmount();
	});

	it('a server snapshot during a lift keeps the preview', async () => {
		const { echo, saves } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await press(wrapper, 'st_1', ' ');
		await press(wrapper, 'st_1', 'ArrowDown');
		echo(['st_1', 'st_2', 'st_3']);
		await flushPromises();
		expect(order(wrapper)).toEqual(['st_2', 'st_1', 'st_3']);
		expect(lifted(wrapper, 'st_1')).toBe(true);

		await press(wrapper, 'st_1', 'Escape');
		expect(order(wrapper)).toEqual(['st_1', 'st_2', 'st_3']);
		expect(saves).toHaveLength(0);
		wrapper.unmount();
	});

	it('a server reorder during a lift becomes the order Escape returns to', async () => {
		const { echo } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await press(wrapper, 'st_1', ' ');
		await press(wrapper, 'st_1', 'ArrowDown');
		echo(['st_3', 'st_1', 'st_2']);
		await flushPromises();
		await press(wrapper, 'st_1', 'Escape');
		expect(order(wrapper)).toEqual(['st_3', 'st_1', 'st_2']);
		wrapper.unmount();
	});

	it('deleting the lifted step ends the lift without saving', async () => {
		const { echo, saves } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await press(wrapper, 'st_2', ' ');
		await press(wrapper, 'st_2', 'ArrowDown');
		echo(['st_1', 'st_3']);
		await flushPromises();
		expect(order(wrapper)).toEqual(['st_1', 'st_3']);
		expect(wrapper.find('[aria-pressed="true"]').exists()).toBe(false);

		// The list follows the server again.
		echo(['st_3', 'st_1']);
		await flushPromises();
		expect(order(wrapper)).toEqual(['st_3', 'st_1']);
		expect(saves).toHaveLength(0);
		wrapper.unmount();
	});

	it('opening a step in the inspector cancels the lift', async () => {
		const { saves } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await press(wrapper, 'st_1', ' ');
		await press(wrapper, 'st_1', 'ArrowDown');
		await wrapper.get('[data-step-title="st_3"]').trigger('click');
		await flushPromises();
		expect(order(wrapper)).toEqual(['st_1', 'st_2', 'st_3']);
		expect(lifted(wrapper, 'st_1')).toBe(false);
		expect(saves).toHaveLength(0);
		wrapper.unmount();
	});

	it('pressing anywhere else cancels the lift', async () => {
		const { saves } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await press(wrapper, 'st_1', ' ');
		await press(wrapper, 'st_1', 'ArrowDown');
		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		await flushPromises();
		expect(order(wrapper)).toEqual(['st_1', 'st_2', 'st_3']);
		expect(lifted(wrapper, 'st_1')).toBe(false);
		expect(saves).toHaveLength(0);
		wrapper.unmount();
	});

	it('a pointer drag started during a lift drops the preview first', async () => {
		const { saves, settle } = stubHeldReorder();
		const wrapper = await mountEditPage();
		const draggable = wrapper.findComponent({ name: 'VueDraggable' });

		await press(wrapper, 'st_1', ' ');
		await press(wrapper, 'st_1', 'ArrowDown');
		draggable.vm.$emit('start', { oldIndex: 2 });
		await flushPromises();
		expect(order(wrapper)).toEqual(['st_1', 'st_2', 'st_3']);
		expect(lifted(wrapper, 'st_1')).toBe(false);

		const [first, second, third] = draggable.props('modelValue') as HarnessStep[];
		draggable.vm.$emit('update:modelValue', [third, first, second]);
		draggable.vm.$emit('end', { oldIndex: 2, newIndex: 0 });
		await flushPromises();
		await settle();
		expect(saves.map((save) => save.stepOrder)).toEqual([['st_3', 'st_1', 'st_2']]);
		wrapper.unmount();
	});
});

describe('adding a step while an order is being saved', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('Add step waits for queued moves, then inserts after the same step', async () => {
		const { saves, adds, settle } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await moveDown(wrapper, 'st_1');
		await moveDown(wrapper, 'st_1');
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);
		// Add under st_3, second on screen, while the server still has st_1 there.
		await addStepAfter(wrapper, 1);
		expect(adds).toHaveLength(0);

		await settle();
		expect(adds).toHaveLength(0);
		await settle();
		expect(adds.map((add) => add.insertAtIndex)).toEqual([2]);

		await adds[0]!.settle();
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_new', 'st_1']);
		expect(saves.map((save) => save.stepOrder)).toEqual([
			['st_2', 'st_1', 'st_3'],
			['st_2', 'st_3', 'st_1'],
		]);
		wrapper.unmount();
	});

	it('a move made while a step is being added saves an order that includes it', async () => {
		const { saves, adds, settle } = stubHeldReorder();
		const wrapper = await mountEditPage();

		await addStepAfter(wrapper, 0);
		expect(adds.map((add) => add.insertAtIndex)).toEqual([1]);
		await moveDown(wrapper, 'st_2');
		expect(order(wrapper)).toEqual(['st_1', 'st_3', 'st_2']);
		// The order waits for the new step instead of leaving it out.
		expect(saves).toHaveLength(0);

		await adds[0]!.settle();
		expect(saves.map((save) => save.stepOrder)).toEqual([['st_1', 'st_new', 'st_3', 'st_2']]);
		await settle();
		expect(order(wrapper)).toEqual(['st_1', 'st_new', 'st_3', 'st_2']);
		wrapper.unmount();
	});
});
