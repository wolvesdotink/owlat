// @vitest-environment happy-dom
/**
 * Activation, Resume and Save draft act on what the inspector shows (#1043).
 *
 * Step edits save themselves, so each of these first waits for the open
 * step's save (`flushStepSave`). When that fails, nothing is activated or
 * resumed and Save draft does not claim the draft was saved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import {
	buttonByText as button,
	mountEditPage,
	stubEditPage,
} from '~/__tests__/automationEditPageHarness';

describe('activation waits for the open step to be saved', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('activates after the save lands', async () => {
		const { steps, runs } = stubEditPage();
		const wrapper = await mountEditPage();
		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();
		expect(steps.flushStepSave).toHaveBeenCalledTimes(1);

		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();
		expect(steps.flushStepSave).toHaveBeenCalledTimes(2);
		expect(runs.activate).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});

	it('shows the save error in the modal and does not activate', async () => {
		const { steps, runs } = stubEditPage();
		const wrapper = await mountEditPage();
		steps.flushStepSave.mockResolvedValue(false);
		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();

		expect(wrapper.get('[role="alert"]').text()).toContain("couldn't be saved");
		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();
		expect(runs.activate).not.toHaveBeenCalled();
		expect(wrapper.find('[role="alert"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('checks readiness against the saved steps after the save', async () => {
		const { steps, runs, canActivate, showToast } = stubEditPage();
		const wrapper = await mountEditPage();
		// The save that just landed is what made the step invalid.
		steps.flushStepSave.mockImplementation(() => {
			canActivate.value = { valid: false, reasons: ['Step 1: choose an email'] };
			return Promise.resolve(true);
		});
		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();

		expect(showToast).toHaveBeenCalledWith('Step 1: choose an email', 'error');
		expect(runs.activate).not.toHaveBeenCalled();
		wrapper.unmount();
	});

	it('does not resume when the save fails', async () => {
		const { steps, runs, showToast } = stubEditPage({ status: 'paused' });
		const wrapper = await mountEditPage();
		steps.flushStepSave.mockResolvedValue(false);
		await button(wrapper, 'Resume').trigger('click');
		await flushPromises();

		expect(runs.resume).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining("wasn't resumed"), 'error');
		wrapper.unmount();
	});

	it('resumes after the save lands', async () => {
		const { steps, runs } = stubEditPage({ status: 'paused' });
		const wrapper = await mountEditPage();
		await button(wrapper, 'Resume').trigger('click');
		await flushPromises();

		expect(steps.flushStepSave).toHaveBeenCalled();
		expect(runs.resume).toHaveBeenCalledTimes(1);
		wrapper.unmount();
	});
});

describe('Save draft', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('does not report a saved draft when the step save failed', async () => {
		const { steps, showToast } = stubEditPage();
		const wrapper = await mountEditPage();
		steps.flushStepSave.mockResolvedValue(false);
		await button(wrapper, 'Save draft').trigger('click');
		await flushPromises();

		expect(showToast).not.toHaveBeenCalledWith('Draft saved');
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining("couldn't be saved"), 'error');
		wrapper.unmount();
	});

	it('reports a saved draft once both parts landed', async () => {
		const { runs, showToast } = stubEditPage();
		const wrapper = await mountEditPage();
		await button(wrapper, 'Save draft').trigger('click');
		await flushPromises();

		expect(runs.update).toHaveBeenCalledTimes(1);
		expect(showToast).toHaveBeenCalledWith('Draft saved');
		wrapper.unmount();
	});
});
