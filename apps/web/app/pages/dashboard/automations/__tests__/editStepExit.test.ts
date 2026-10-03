// @vitest-environment happy-dom
/**
 * Leaving the open step never drops its edits silently (#1044).
 *
 * Close, Add step, picking another step and a reorder all wait for the open
 * step's save and then go ahead. Only a failed save (or a same-step change
 * made elsewhere) stops them, with Retry / Discard / Stay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import {
	buttonByText,
	mountEditPage,
	stubEditPage,
	type EditPageWrapper,
} from '~/__tests__/automationEditPageHarness';

const panel = (wrapper: EditPageWrapper) =>
	wrapper.findComponent({ name: 'AutomationsStepEditorPanel' });
const dialog = (wrapper: EditPageWrapper) =>
	wrapper.findComponent({ name: 'AutomationsStepSaveFailedDialog' });
const isDialogOpen = (wrapper: EditPageWrapper) =>
	wrapper.find('[data-testid="step-save-failed"]').exists();

describe('leaving the open step', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('closes the inspector once the save lands, without asking', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_1';
		const wrapper = await mountEditPage();

		panel(wrapper).vm.$emit('close');
		await flushPromises();

		expect(steps.flushStepSave).toHaveBeenCalled();
		expect(steps.selectedStepId.value).toBeNull();
		expect(isDialogOpen(wrapper)).toBe(false);
		wrapper.unmount();
	});

	it('asks instead of closing when the save fails, and Stay keeps the step', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_1';
		steps.flushStepSave.mockResolvedValue(false);
		const wrapper = await mountEditPage();

		panel(wrapper).vm.$emit('close');
		await flushPromises();
		expect(isDialogOpen(wrapper)).toBe(true);
		expect(steps.selectedStepId.value).toBe('st_1');

		dialog(wrapper).vm.$emit('stay');
		await flushPromises();
		expect(isDialogOpen(wrapper)).toBe(false);
		expect(steps.selectedStepId.value).toBe('st_1');
		expect(steps.discardStepChanges).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it('Discard drops the edits and carries on', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_1';
		steps.flushStepSave.mockResolvedValue(false);
		const wrapper = await mountEditPage();

		panel(wrapper).vm.$emit('close');
		await flushPromises();
		dialog(wrapper).vm.$emit('discard');
		await flushPromises();

		expect(steps.discardStepChanges).toHaveBeenCalledTimes(1);
		expect(steps.selectedStepId.value).toBeNull();
		wrapper.unmount();
	});

	it('Retry carries on once the save lands, and keeps asking while it fails', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_1';
		steps.flushStepSave.mockResolvedValue(false);
		const wrapper = await mountEditPage();

		panel(wrapper).vm.$emit('close');
		await flushPromises();
		dialog(wrapper).vm.$emit('retry');
		await flushPromises();
		expect(isDialogOpen(wrapper)).toBe(true);
		expect(steps.selectedStepId.value).toBe('st_1');

		steps.flushStepSave.mockResolvedValue(true);
		dialog(wrapper).vm.$emit('retry');
		await flushPromises();
		expect(isDialogOpen(wrapper)).toBe(false);
		expect(steps.selectedStepId.value).toBeNull();
		wrapper.unmount();
	});

	it('a same-step change made elsewhere asks whose version to keep', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_1';
		steps.hasRemoteStepChange.value = true;
		steps.flushStepSave.mockResolvedValue(false);
		const wrapper = await mountEditPage();

		panel(wrapper).vm.$emit('close');
		await flushPromises();
		expect(dialog(wrapper).props('conflict')).toBe(true);

		dialog(wrapper).vm.$emit('retry');
		await flushPromises();
		expect(steps.keepLocalStepConfig).toHaveBeenCalledTimes(1);
		expect(steps.selectedStepId.value).toBeNull();
		wrapper.unmount();
	});

	it('does not add a step until the open step is saved', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_1';
		steps.flushStepSave.mockResolvedValue(false);
		const wrapper = await mountEditPage();

		steps.addStepDropdownIndex.value = 0;
		await flushPromises();
		await buttonByText(wrapper, 'Send email').trigger('click');
		await flushPromises();

		expect(steps.handleAddStep).not.toHaveBeenCalled();
		expect(isDialogOpen(wrapper)).toBe(true);

		dialog(wrapper).vm.$emit('discard');
		await flushPromises();
		expect(steps.handleAddStep).toHaveBeenCalledWith('email', 1);
		wrapper.unmount();
	});

	it('selects another step only after the open one is saved', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_1';
		steps.flushStepSave.mockResolvedValue(false);
		const wrapper = await mountEditPage();

		await wrapper.findAll('[data-testid="automation-step"]')[1]!.find('.card').trigger('click');
		await flushPromises();
		expect(steps.selectedStepId.value).toBe('st_1');
		expect(isDialogOpen(wrapper)).toBe(true);

		steps.flushStepSave.mockResolvedValue(true);
		dialog(wrapper).vm.$emit('retry');
		await flushPromises();
		expect(steps.selectedStepId.value).toBe('st_2');
		wrapper.unmount();
	});

	it('a reorder waits for the save; Stay puts the saved order back', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_1';
		steps.flushStepSave.mockResolvedValue(false);
		const wrapper = await mountEditPage();

		wrapper.findComponent({ name: 'VueDraggable' }).vm.$emit('end', { oldIndex: 0, newIndex: 2 });
		await flushPromises();
		expect(steps.persistStepOrder).not.toHaveBeenCalled();

		dialog(wrapper).vm.$emit('stay');
		await flushPromises();
		expect(steps.persistStepOrder).not.toHaveBeenCalled();
		const ids = wrapper
			.findAll('[data-testid="automation-step"]')
			.map((card) => card.text().match(/About (st_\d)/)?.[1]);
		expect(ids).toEqual(['st_1', 'st_2', 'st_3']);
		wrapper.unmount();
	});
});
