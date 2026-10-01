// @vitest-environment happy-dom
/**
 * The inspector takes space only while a step is open (#1046). With nothing
 * selected the canvas has the full width; below `lg` the open inspector is a
 * sheet, and what it covers leaves the tab order until it closes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountEditPage, stubEditPage } from './editPageHarness';

const canvas = (wrapper: Awaited<ReturnType<typeof mountEditPage>>) =>
	wrapper.get('[data-testid="automation-step"]').element.closest('[class*="overflow-y-auto"]')!;

describe('step inspector layout', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('renders no inspector while no step is selected', async () => {
		stubEditPage();
		const wrapper = await mountEditPage();
		expect(wrapper.findComponent({ name: 'AutomationsStepEditorPanel' }).exists()).toBe(false);
		wrapper.unmount();
	});

	it('renders the inspector for the selected step', async () => {
		const { steps } = stubEditPage();
		steps.selectedStepId.value = 'st_2';
		const wrapper = await mountEditPage();
		expect(wrapper.findComponent({ name: 'AutomationsStepEditorPanel' }).exists()).toBe(true);
		expect(canvas(wrapper).hasAttribute('inert')).toBe(false);
		wrapper.unmount();
	});

	it('takes the covered canvas out of the tab order while the sheet is open', async () => {
		const { steps } = stubEditPage({}, { wide: false });
		steps.selectedStepId.value = 'st_2';
		const wrapper = await mountEditPage();
		expect(canvas(wrapper).hasAttribute('inert')).toBe(true);

		steps.selectedStepId.value = null;
		await wrapper.vm.$nextTick();
		expect(canvas(wrapper).hasAttribute('inert')).toBe(false);
		wrapper.unmount();
	});
});
