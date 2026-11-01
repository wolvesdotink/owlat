/**
 * The auto-close settings card: it saves the switch and the days, and refuses
 * days the backend would refuse before anything is sent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import InboxAutoClosePolicyForm from '../InboxAutoClosePolicyForm.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountForm(policy = { isEnabled: false, quietDays: 7 }) {
	return mount(InboxAutoClosePolicyForm, {
		props: { policy },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiCard: { template: '<section><slot /></section>' },
				UiSwitch: {
					props: ['modelValue', 'label'],
					emits: ['update:modelValue'],
					template:
						'<button class="switch" :aria-pressed="modelValue" @click="$emit(\'update:modelValue\', !modelValue)">{{ label }}</button>',
				},
				UiButton: {
					props: ['disabled'],
					emits: ['click'],
					template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

describe('InboxAutoClosePolicyForm', () => {
	it('saves the switch and the days', async () => {
		const wrapper = mountForm();
		await wrapper.get('.switch').trigger('click');
		await wrapper.get('[data-testid="inbox-auto-close-days"]').setValue('14');
		await wrapper.get('[data-testid="inbox-auto-close-save"]').trigger('click');
		expect(wrapper.emitted('save')).toEqual([[{ isEnabled: true, quietDays: 14 }]]);
	});

	it('refuses days outside 1 to 365 without saving', async () => {
		const wrapper = mountForm({ isEnabled: true, quietDays: 7 });
		await wrapper.get('[data-testid="inbox-auto-close-days"]').setValue('0');
		expect(wrapper.get('[role="alert"]').text()).toBe(
			'Enter a whole number of days between 1 and 365.'
		);
		const save = wrapper.get('[data-testid="inbox-auto-close-save"]');
		expect(save.attributes('disabled')).toBeDefined();
		await save.trigger('click');
		expect(wrapper.emitted('save')).toBeUndefined();
	});

	it('follows a newly loaded policy', async () => {
		const wrapper = mountForm();
		await wrapper.setProps({ policy: { isEnabled: true, quietDays: 30 } });
		const input = wrapper.get('[data-testid="inbox-auto-close-days"]').element as HTMLInputElement;
		expect(input.value).toBe('30');
		expect(wrapper.get('.switch').attributes('aria-pressed')).toBe('true');
	});
});
