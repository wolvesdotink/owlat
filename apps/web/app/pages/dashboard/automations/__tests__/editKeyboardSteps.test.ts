// @vitest-environment happy-dom
/**
 * Opening and reordering steps without a pointer (#1045).
 *
 * Each step's title is a real button (with `aria-current="step"` while it is
 * open), and its drag handle is a button that lifts, moves and drops the step
 * from the keyboard. The drop saves the order on screen the same way a
 * pointer drag does, and every position change is announced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { mountEditPage, stubEditPage, type EditPageWrapper } from './editPageHarness';

const titles = (wrapper: EditPageWrapper) => wrapper.findAll('[data-step-title]');
const handle = (wrapper: EditPageWrapper, id: string) => wrapper.get(`[data-step-handle="${id}"]`);
const order = (wrapper: EditPageWrapper) =>
	titles(wrapper).map((title) => title.attributes('data-step-title'));
const press = async (wrapper: EditPageWrapper, id: string, key: string) => {
	await handle(wrapper, id).trigger('keydown', { key });
	await flushPromises();
};

describe('keyboard step selection', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('gives every step a title button named after the step', async () => {
		stubEditPage();
		const wrapper = await mountEditPage();

		const buttons = titles(wrapper);
		expect(buttons).toHaveLength(3);
		for (const [index, button] of buttons.entries()) {
			expect(button.element.tagName).toBe('BUTTON');
			expect(button.attributes('type')).toBe('button');
			expect(button.text()).toContain(`Step ${index + 1}`);
		}
		wrapper.unmount();
	});

	it('opens a step from its title and marks it current', async () => {
		const { steps } = stubEditPage();
		const wrapper = await mountEditPage();

		await titles(wrapper)[1]!.trigger('click');
		await flushPromises();

		expect(steps.selectedStepId.value).toBe('st_2');
		expect(titles(wrapper)[1]!.attributes('aria-current')).toBe('step');
		expect(titles(wrapper)[0]!.attributes('aria-current')).toBeUndefined();
		wrapper.unmount();
	});

	it('returns focus to the step title when the inspector closes', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_2';
		const wrapper = await mountEditPage();

		wrapper.findComponent({ name: 'AutomationsStepEditorPanel' }).vm.$emit('close');
		await flushPromises();

		expect(document.activeElement?.getAttribute('data-step-title')).toBe('st_2');
		wrapper.unmount();
	});
});

describe('keyboard step reordering', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('lifts with Space, moves with the arrows and drops with Space', async () => {
		const { steps, announce } = stubEditPage();
		const wrapper = await mountEditPage();

		await press(wrapper, 'st_1', ' ');
		expect(handle(wrapper, 'st_1').attributes('aria-pressed')).toBe('true');
		expect(announce).toHaveBeenLastCalledWith('Picked up step 1 of 3.');

		await press(wrapper, 'st_1', 'ArrowDown');
		expect(order(wrapper)).toEqual(['st_2', 'st_1', 'st_3']);
		expect(announce).toHaveBeenLastCalledWith('Step 2 of 3.');
		await press(wrapper, 'st_1', 'ArrowDown');
		expect(announce).toHaveBeenLastCalledWith('Step 3 of 3.');
		// Already last: nothing moves.
		await press(wrapper, 'st_1', 'ArrowDown');
		expect(order(wrapper)).toEqual(['st_2', 'st_3', 'st_1']);
		expect(document.activeElement?.getAttribute('data-step-handle')).toBe('st_1');

		await press(wrapper, 'st_1', ' ');
		// The same reorder path a pointer drag takes.
		expect(steps.persistStepOrder).toHaveBeenCalledWith(['st_2', 'st_3', 'st_1']);
		expect(announce).toHaveBeenLastCalledWith('Step moved to position 3 of 3.');
		expect(handle(wrapper, 'st_1').attributes('aria-pressed')).toBe('false');
		wrapper.unmount();
	});

	it('Escape puts the step back without saving', async () => {
		const { steps, announce } = stubEditPage();
		const wrapper = await mountEditPage();

		await press(wrapper, 'st_2', ' ');
		await press(wrapper, 'st_2', 'ArrowUp');
		expect(order(wrapper)).toEqual(['st_2', 'st_1', 'st_3']);
		await press(wrapper, 'st_2', 'Escape');

		expect(order(wrapper)).toEqual(['st_1', 'st_2', 'st_3']);
		expect(steps.persistStepOrder).not.toHaveBeenCalled();
		expect(announce).toHaveBeenLastCalledWith('Move cancelled. Step 2 of 3.');
		wrapper.unmount();
	});

	it('puts the saved order back when the reorder fails', async () => {
		const { steps } = stubEditPage();
		steps.persistStepOrder.mockResolvedValue(false);
		const wrapper = await mountEditPage();

		await press(wrapper, 'st_1', ' ');
		await press(wrapper, 'st_1', 'ArrowDown');
		await press(wrapper, 'st_1', ' ');

		expect(order(wrapper)).toEqual(['st_1', 'st_2', 'st_3']);
		wrapper.unmount();
	});

	it('Move down and Move up in the step actions use the same reorder', async () => {
		const { steps } = stubEditPage();
		const wrapper = await mountEditPage();
		const menuItem = (stepIndex: number, label: string) => {
			const card = wrapper.findAll('[data-testid="automation-step"]').at(stepIndex)!;
			return card.findAll('[role="menuitem"]').find((item) => item.text() === label)!;
		};

		expect(menuItem(0, 'Move up').attributes('disabled')).toBeDefined();
		expect(menuItem(2, 'Move down').attributes('disabled')).toBeDefined();

		await menuItem(0, 'Move down').trigger('click');
		await flushPromises();
		expect(steps.persistStepOrder).toHaveBeenCalledWith(['st_2', 'st_1', 'st_3']);
		expect(order(wrapper)).toEqual(['st_2', 'st_1', 'st_3']);
		expect(document.activeElement?.getAttribute('data-step-title')).toBe('st_1');
		wrapper.unmount();
	});
});
