/**
 * `aria-disabled` on UiButton. Links have no native `disabled`, so the button
 * derives it from `disabled`/`loading`. A native button keeps a caller's own
 * `aria-disabled`: that is the focusable-but-unavailable control (the caller
 * guards its click), and the component's own binding used to overwrite it.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Button from '../components/ui/Button.vue';

const stubs = { NuxtLink: true };

describe('UiButton aria-disabled', () => {
	it('keeps a caller-supplied aria-disabled on a native button, which stays focusable', () => {
		const wrapper = mount(Button, {
			attrs: { 'aria-disabled': 'true', 'aria-describedby': 'why' },
			slots: { default: 'Publish' },
			global: { stubs },
		});
		const el = wrapper.element as HTMLButtonElement;

		expect(el.tagName).toBe('BUTTON');
		expect(el.disabled).toBe(false);
		expect(wrapper.attributes('aria-disabled')).toBe('true');
		expect(wrapper.attributes('aria-describedby')).toBe('why');
	});

	it('still emits click for a caller-held button: the caller owns the guard', async () => {
		const wrapper = mount(Button, {
			attrs: { 'aria-disabled': 'true' },
			global: { stubs },
		});
		await wrapper.trigger('click');
		expect(wrapper.emitted('click')).toHaveLength(1);
	});

	it('uses native disabled, and no aria-disabled, for a disabled native button', async () => {
		const wrapper = mount(Button, { props: { disabled: true }, global: { stubs } });

		expect((wrapper.element as HTMLButtonElement).disabled).toBe(true);
		expect(wrapper.attributes('aria-disabled')).toBeUndefined();
		await wrapper.trigger('click');
		expect(wrapper.emitted('click')).toBeUndefined();
	});

	it('derives aria-disabled from props for a link', () => {
		const wrapper = mount(Button, {
			props: { href: 'https://owlat.example', disabled: true },
			global: { stubs },
		});

		expect(wrapper.element.tagName).toBe('A');
		expect(wrapper.attributes('aria-disabled')).toBe('true');
	});
});
