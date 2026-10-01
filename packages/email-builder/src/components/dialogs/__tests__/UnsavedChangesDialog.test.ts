// @vitest-environment happy-dom
//
// The leave dialog's busy contract: while a Save runs, Save shows progress and
// cannot be clicked again, Discard waits for it, and Cancel stays available.
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import UnsavedChangesDialog from '../UnsavedChangesDialog.vue';

let wrappers: VueWrapper[] = [];
afterEach(() => {
	for (const w of wrappers) w.unmount();
	wrappers = [];
});

function render(saving?: boolean) {
	const wrapper = mount(UnsavedChangesDialog, {
		props: saving === undefined ? { show: true } : { show: true, saving },
		global: {
			stubs: {
				// The modal's own chrome is not under test; render its slots in place.
				UiModal: {
					template: '<div><slot /><footer><slot name="footer" /></footer></div>',
				},
				Icon: { template: '<i class="spinner" />' },
			},
		},
	});
	wrappers.push(wrapper);
	const button = (label: string) => {
		const match = wrapper.findAll('button').find((b) => b.text() === label);
		if (!match) throw new Error(`no ${label} button`);
		return match;
	};
	return { wrapper, button };
}

describe('UnsavedChangesDialog', () => {
	it('offers every choice when no save is running', async () => {
		const { wrapper, button } = render();
		for (const label of ['Discard', 'Cancel', 'Save']) {
			expect(button(label).attributes('disabled')).toBeUndefined();
		}
		await button('Save').trigger('click');
		await button('Discard').trigger('click');
		await button('Cancel').trigger('click');
		expect(wrapper.emitted('save')).toHaveLength(1);
		expect(wrapper.emitted('discard')).toHaveLength(1);
		expect(wrapper.emitted('close')).toHaveLength(1);
	});

	it('locks Save and Discard while saving, and keeps Cancel', async () => {
		const { wrapper, button } = render(true);
		expect(button('Save').attributes('disabled')).toBeDefined();
		expect(button('Save').find('.spinner').exists()).toBe(true);
		expect(button('Discard').attributes('disabled')).toBeDefined();
		expect(button('Cancel').attributes('disabled')).toBeUndefined();

		await button('Save').trigger('click');
		await button('Discard').trigger('click');
		await button('Cancel').trigger('click');
		expect(wrapper.emitted('save')).toBeUndefined();
		expect(wrapper.emitted('discard')).toBeUndefined();
		expect(wrapper.emitted('close')).toHaveLength(1);
	});
});
