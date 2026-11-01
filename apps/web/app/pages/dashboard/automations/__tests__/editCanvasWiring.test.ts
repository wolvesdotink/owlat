/**
 * The builder's canvas and header reach the page's handlers: the trigger card
 * and its Edit link, the "+" menus that add a step at the top or after a step,
 * the empty canvas's add buttons, a step's Delete, what still blocks a draft,
 * Pause, and the activation dialog's summary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import {
	buttonByText as button,
	mountEditPage,
	stubEditPage,
} from '~/__tests__/automationEditPageHarness';

const addButtons = (wrapper: Awaited<ReturnType<typeof mountEditPage>>) =>
	wrapper.findAll('button').filter((b) => b.attributes('aria-label') === 'Add');

describe('automation builder canvas', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('shows the trigger with a link back to the trigger picker, then every step and the end', async () => {
		stubEditPage();
		const wrapper = await mountEditPage({
			NuxtLink: { props: ['to'], template: '<a :data-to="to"><slot /></a>' },
		});

		const text = wrapper.text();
		expect(text).toContain('Trigger');
		expect(text).toContain('Contact created');
		expect(wrapper.find('a[data-to="/dashboard/automations/new?edit=au_1"]').text()).toBe('Edit');
		expect(wrapper.findAll('[data-testid="automation-step"]')).toHaveLength(3);
		expect(text).toContain('About st_2');
		expect(text).toContain('End of automation');
		wrapper.unmount();
	});

	it('adds a step at the top from the trigger, and after a step from its "+"', async () => {
		const { steps } = stubEditPage();
		const wrapper = await mountEditPage();

		// One "+" under the trigger, then one under each step.
		expect(addButtons(wrapper)).toHaveLength(4);
		await addButtons(wrapper)[0]!.trigger('click');
		expect(steps.addStepDropdownIndex.value).toBe(-1);
		expect(wrapper.find('[data-testid="add-step-menu"]').exists()).toBe(false);
		await button(wrapper, 'Send email').trigger('click');
		await flushPromises();
		expect(steps.closeDropdowns).toHaveBeenCalled();
		expect(steps.handleAddStep).toHaveBeenLastCalledWith('email', 0);

		steps.addStepDropdownIndex.value = null;
		await addButtons(wrapper)[2]!.trigger('click');
		expect(steps.addStepDropdownIndex.value).toBe(1);
		const menu = wrapper.get('[data-testid="add-step-menu"]');
		expect(menu.text()).toContain('Add step');
		await menu.get('button').trigger('click');
		await flushPromises();
		expect(steps.handleAddStep).toHaveBeenLastCalledWith('email', 2);

		// The same "+" closes its own menu.
		steps.addStepDropdownIndex.value = 1;
		await flushPromises();
		await addButtons(wrapper)[2]!.trigger('click');
		expect(steps.addStepDropdownIndex.value).toBeNull();
		wrapper.unmount();
	});

	it('offers the first email or delay on an empty canvas', async () => {
		const { steps } = stubEditPage({ steps: [] });
		const wrapper = await mountEditPage();

		expect(wrapper.text()).toContain('No steps yet');
		expect(wrapper.text()).not.toContain('End of automation');
		await button(wrapper, 'Add email step').trigger('click');
		await flushPromises();
		expect(steps.handleAddStep).toHaveBeenLastCalledWith('email', undefined);
		await button(wrapper, 'Add delay step').trigger('click');
		await flushPromises();
		expect(steps.handleAddStep).toHaveBeenLastCalledWith('delay', undefined);
		wrapper.unmount();
	});

	it('deletes a step from its actions menu', async () => {
		const { steps } = stubEditPage();
		const wrapper = await mountEditPage();
		const deletes = wrapper.findAll('[role="menuitem"]').filter((b) => b.text() === 'Delete');
		expect(deletes).toHaveLength(3);
		await deletes[1]!.trigger('click');
		expect(steps.handleDeleteStep).toHaveBeenCalledWith('st_2');
		wrapper.unmount();
	});

	it('lists what still blocks a draft, and only for a draft', async () => {
		const { canActivate, data } = stubEditPage();
		canActivate.value = { valid: false, reasons: ['Step 1: choose an email', 'Add a delay'] };
		const wrapper = await mountEditPage();

		const items = wrapper.findAll('li').map((li) => li.text());
		expect(wrapper.text()).toContain('Fix these issues before activating:');
		expect(items).toEqual(['Step 1: choose an email', 'Add a delay']);

		data.value = { ...data.value, status: 'paused' };
		await flushPromises();
		expect(wrapper.text()).not.toContain('Fix these issues before activating:');
		wrapper.unmount();
	});
});

describe('automation builder header', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('pauses an active automation', async () => {
		const { runs, showToast } = stubEditPage({ status: 'active' });
		const wrapper = await mountEditPage();

		expect(wrapper.text()).toContain('Active');
		await button(wrapper, 'Pause').trigger('click');
		await flushPromises();
		expect(runs.pause).toHaveBeenCalledWith({ automationId: 'au_1' });
		expect(showToast).toHaveBeenCalledWith('Automation paused');
		wrapper.unmount();
	});

	it('summarizes what goes live in the activation dialog, and Cancel closes it', async () => {
		stubEditPage();
		const wrapper = await mountEditPage();
		await button(wrapper, 'Activate').trigger('click');
		await flushPromises();

		const text = wrapper.text();
		expect(text).toContain('Activate automation?');
		expect(text).toContain('Welcome sequence');
		expect(text).toContain('Contact created');
		expect(text).toContain('3 steps');

		await button(wrapper, 'Cancel').trigger('click');
		expect(wrapper.text()).not.toContain('Activate automation?');
		wrapper.unmount();
	});
});
