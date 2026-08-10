// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import Disclosure from '@owlat/ui/components/ui/Disclosure.vue';

describe('UiDisclosure', () => {
	it('keeps advanced content out of the DOM until its accessible trigger opens it', async () => {
		const open = ref(false);
		const wrapper = mount(Disclosure, {
			props: {
				modelValue: open.value,
				'onUpdate:modelValue': (value: boolean) => (open.value = value),
			},
			slots: { default: '<p>Technical detail</p>' },
			global: { stubs: { Icon: true } },
		});
		const trigger = wrapper.get('button');
		expect(trigger.attributes('aria-expanded')).toBe('false');
		expect(wrapper.text()).not.toContain('Technical detail');

		await trigger.trigger('click');
		await wrapper.setProps({ modelValue: open.value });
		expect(trigger.attributes('aria-expanded')).toBe('true');
		expect(wrapper.text()).toContain('Technical detail');
		expect(trigger.attributes('aria-controls')).toBeTruthy();
	});
});
