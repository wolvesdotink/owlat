// @vitest-environment happy-dom
/**
 * "Require TLS for incoming mail" moved from the Sealed mail page to Delivery
 * provider → Incoming mail. Same setting, same write; what it must keep doing
 * is read the stored value, save a change, and roll back a refused one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config, flushPromises, mount } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import InboundTlsRequirementCard from '../InboundTlsRequirementCard.vue';

config.global.plugins = [...(config.global.plugins ?? []), createTestI18n()];

const settings: Ref<{ isInboundTlsRequired?: boolean } | undefined> = ref(undefined);
const run = vi.fn();
let postbox = true;

beforeEach(() => {
	settings.value = {};
	postbox = true;
	run.mockReset();
	run.mockResolvedValue({ ok: true });
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) => flag === 'postbox' && postbox,
	}));
	vi.stubGlobal('useOrganizationQuery', () => ({ data: settings }));
	vi.stubGlobal('useBackendOperation', () => ({ run, isLoading: ref(false) }));
});

const stubs = {
	UiCard: { template: '<section><slot /></section>' },
	UiIconBox: true,
	UiSwitch: {
		props: ['modelValue', 'disabled', 'label'],
		emits: ['update:modelValue'],
		template:
			'<button type="button" role="switch" :aria-checked="String(modelValue)" :aria-label="label" :disabled="disabled" @click="$emit(\'update:modelValue\', !modelValue)" />',
	},
};

function mountCard() {
	return mount(InboundTlsRequirementCard, { global: { stubs } });
}

describe('InboundTlsRequirementCard', () => {
	it('reads an unset value as required, like the backend', () => {
		const wrapper = mountCard();
		expect(wrapper.text()).toContain('Require TLS for incoming mail');
		const toggle = wrapper.find('[role="switch"]');
		expect(toggle.attributes('aria-checked')).toBe('true');
		// The switch is named for the setting; its state is aria-checked, not the label.
		expect(toggle.attributes('aria-label')).toBe('Require TLS for incoming mail');
		expect(wrapper.find('[data-testid="inbound-tls-plaintext-warning"]').exists()).toBe(false);
	});

	it('saves the change and warns about plaintext once it is off', async () => {
		const wrapper = mountCard();
		await wrapper.find('[role="switch"]').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({ isInboundTlsRequired: false });
		expect(wrapper.find('[role="switch"]').attributes('aria-checked')).toBe('false');
		expect(wrapper.find('[data-testid="inbound-tls-plaintext-warning"]').exists()).toBe(true);
	});

	it('rolls back when the save is refused', async () => {
		run.mockResolvedValue({ ok: false });
		const wrapper = mountCard();
		await wrapper.find('[role="switch"]').trigger('click');
		await flushPromises();
		expect(wrapper.find('[role="switch"]').attributes('aria-checked')).toBe('true');
	});

	it('is not shown where there are no hosted mailboxes to receive for', () => {
		postbox = false;
		const wrapper = mountCard();
		expect(wrapper.find('[data-testid="inbound-tls-card"]').exists()).toBe(false);
	});
});
