/**
 * UiTextarea follows UiInput's attribute contract: the error and the counter
 * are announced with the field, and a caller's attributes reach the native
 * <textarea> rather than the container around it.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import UiTextarea from '../components/ui/Textarea.vue';

describe('UiTextarea semantics', () => {
	it('marks an errored, required field invalid and points at the error and counter', () => {
		const wrapper = mount(UiTextarea, {
			props: { id: 'note', error: 'Too short', required: true, maxLength: 200, label: 'Note' },
		});
		const textarea = wrapper.get('textarea');

		expect(textarea.attributes('aria-invalid')).toBe('true');
		expect(textarea.attributes('aria-required')).toBe('true');
		expect(textarea.attributes('required')).toBeDefined();
		expect(textarea.attributes('aria-describedby')).toBe('note-error note-count');
		expect(wrapper.get('#note-error').text()).toBe('Too short');
		expect(wrapper.get('#note-count').text()).toBe('0/200');
	});

	it('forwards native attributes to the textarea and keeps class on the container', () => {
		const wrapper = mount(UiTextarea, {
			attrs: { class: 'mt-4', name: 'reason', 'aria-label': 'Reason', 'data-testid': 'r' },
		});
		const textarea = wrapper.get('textarea');

		expect(textarea.attributes('name')).toBe('reason');
		expect(textarea.attributes('aria-label')).toBe('Reason');
		expect(textarea.attributes('data-testid')).toBe('r');
		expect(wrapper.classes()).toContain('mt-4');
		expect(textarea.classes()).not.toContain('mt-4');
	});
});
