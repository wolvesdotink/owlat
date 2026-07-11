// @vitest-environment happy-dom
/**
 * AiModelPicker — a curated-model dropdown with a free-text override.
 *
 * Covers the one conditional-render contract: the free-text input appears only
 * when the dropdown sits on the `CUSTOM_MODEL_VALUE` sentinel, and typing there
 * flows back out through the `custom` model.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import AiModelPicker from '../AiModelPicker.vue';
import { CUSTOM_MODEL_VALUE } from '~/utils/aiProviders';

// UiSelect/UiInput are Nuxt UI auto-imports; render them as lightweight stubs so
// we can assert presence and read the props that drive behaviour.
const UiSelectStub = {
	props: ['modelValue', 'label', 'options', 'disabled'],
	emits: ['update:modelValue'],
	template: '<select data-testid="ui-select" />',
};
const UiInputStub = {
	props: ['modelValue', 'type', 'placeholder', 'disabled'],
	emits: ['update:modelValue'],
	template: '<input data-testid="ui-input" :placeholder="placeholder" />',
};

function mountPicker(props: Record<string, unknown> = {}) {
	return mount(AiModelPicker, {
		props: {
			label: 'Capable model',
			options: [{ value: 'gpt-4o', label: 'gpt-4o' }],
			choice: 'gpt-4o',
			custom: '',
			...props,
		},
		global: { stubs: { UiSelect: UiSelectStub, UiInput: UiInputStub } },
	});
}

const inputSel = '[data-testid="ui-input"]';

describe('AiModelPicker', () => {
	it('hides the free-text input for a curated choice', () => {
		const wrapper = mountPicker({ choice: 'gpt-4o' });
		expect(wrapper.find(inputSel).exists()).toBe(false);
	});

	it('reveals the free-text input only on the custom-model sentinel', async () => {
		const wrapper = mountPicker({ choice: 'gpt-4o' });
		expect(wrapper.find(inputSel).exists()).toBe(false);

		await wrapper.setProps({ choice: CUSTOM_MODEL_VALUE });
		expect(wrapper.find(inputSel).exists()).toBe(true);
	});

	it('renders an optional hint', () => {
		const wrapper = mountPicker({ hint: 'Used for hard tasks.' });
		expect(wrapper.text()).toContain('Used for hard tasks.');
	});
});
