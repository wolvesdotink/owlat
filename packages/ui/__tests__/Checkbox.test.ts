/**
 * UiCheckbox's state and name live on the native input, where assistive tech
 * reads them: `indeterminate` is the DOM property browsers expose as
 * aria-checked="mixed", and `ariaLabel` names a box that has no visible label.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Checkbox from '../components/ui/Checkbox.vue';

describe('UiCheckbox', () => {
	it('puts checked and indeterminate on the input and follows prop changes', async () => {
		const wrapper = mount(Checkbox, { props: { modelValue: false, indeterminate: true } });
		const input = wrapper.get<HTMLInputElement>('input[type="checkbox"]').element;
		expect([input.checked, input.indeterminate]).toEqual([false, true]);

		await wrapper.setProps({ modelValue: true, indeterminate: false });
		expect([input.checked, input.indeterminate]).toEqual([true, false]);
	});

	it('names the input itself, not the wrapping label', () => {
		const wrapper = mount(Checkbox, { props: { ariaLabel: 'Select ada@example.com' } });
		expect(wrapper.get('input').attributes('aria-label')).toBe('Select ada@example.com');
		expect(wrapper.get('label').attributes('aria-label')).toBeUndefined();
	});

	it('leaves the input unnamed by aria-label when a visible label names it', () => {
		const wrapper = mount(Checkbox, { props: { label: 'Require double opt-in' } });
		expect(wrapper.get('input').attributes('aria-label')).toBeUndefined();
		expect(wrapper.get('label').text()).toBe('Require double opt-in');
	});

	it('emits the new checked value on change', async () => {
		const wrapper = mount(Checkbox, { props: { modelValue: false } });
		await wrapper.get('input').setValue(true);
		expect(wrapper.emitted('update:modelValue')).toEqual([[true]]);
	});
});
