/**
 * The transactional send limits card on the API settings page: it shows the
 * caps in force with their defaults, saves an admin's change (a cap switched
 * off stays off with its count, never a zero), and refuses a count the backend
 * would refuse before anything is sent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TransactionalSendLimits from '../TransactionalSendLimits.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const HOUR = 60 * 60 * 1000;
const DEFAULTS = {
	perRecipient: { isEnabled: true, count: 5, windowMs: HOUR },
	perApiKeyDaily: { isEnabled: true, count: 50_000 },
};
const BOUNDS = {
	perRecipientCount: { min: 1, max: 1_000 },
	perApiKeyDailyCount: { min: 1, max: 10_000_000 },
};

function mountCard(props: { caps?: typeof DEFAULTS; canManage?: boolean } = {}) {
	return mount(TransactionalSendLimits, {
		props: {
			caps: props.caps ?? DEFAULTS,
			defaults: DEFAULTS,
			bounds: BOUNDS,
			canManage: props.canManage ?? true,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiSwitch: {
					props: ['modelValue', 'label'],
					emits: ['update:modelValue'],
					template:
						'<button type="button" :aria-pressed="modelValue" @click="$emit(\'update:modelValue\', !modelValue)">{{ label }}</button>',
				},
				UiButton: {
					props: ['disabled', 'type'],
					emits: ['click'],
					template:
						'<button :type="type ?? \'button\'" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

describe('TransactionalSendLimits', () => {
	it('shows the caps in force and the defaults they protect', () => {
		const wrapper = mountCard({
			caps: { ...DEFAULTS, perApiKeyDaily: { isEnabled: false, count: 50_000 } },
		});
		expect(wrapper.get('[data-testid="send-limits-recipient"]').text()).toBe('5 per hour');
		expect(wrapper.get('[data-testid="send-limits-daily"]').text()).toBe('Off');
		expect(wrapper.text()).toContain('Default: 5 per hour.');
		expect(wrapper.text()).toContain('Default: 50,000 per UTC day.');
	});

	it('saves a cap switched off with its count kept, and a new daily count', async () => {
		const wrapper = mountCard();
		await wrapper.get('[data-testid="send-limits-edit"]').trigger('click');
		await wrapper.get('[data-testid="send-limits-recipient-switch"]').trigger('click');
		await wrapper.get('[data-testid="send-limits-daily-count"]').setValue('1000');
		await wrapper.get('form').trigger('submit');

		expect(wrapper.emitted('save')).toEqual([
			[
				{
					perRecipient: { isEnabled: false, count: 5, windowMs: HOUR },
					perApiKeyDaily: { isEnabled: true, count: 1000 },
				},
			],
		]);
	});

	it('refuses a count of zero without saving', async () => {
		const wrapper = mountCard();
		await wrapper.get('[data-testid="send-limits-edit"]').trigger('click');
		await wrapper.get('[data-testid="send-limits-recipient-count"]').setValue('0');

		expect(wrapper.get('[role="alert"]').text()).toBe('Enter a whole number between 1 and 1,000.');
		expect(wrapper.get('[data-testid="send-limits-save"]').attributes('disabled')).toBeDefined();
		await wrapper.get('form').trigger('submit');
		expect(wrapper.emitted('save')).toBeUndefined();
	});

	it('restores the defaults into the form', async () => {
		const wrapper = mountCard({
			caps: {
				perRecipient: { isEnabled: false, count: 20, windowMs: 24 * HOUR },
				perApiKeyDaily: { isEnabled: true, count: 10 },
			},
		});
		await wrapper.get('[data-testid="send-limits-edit"]').trigger('click');
		const restore = wrapper.findAll('button').find((b) => b.text() === 'Restore defaults');
		await restore!.trigger('click');
		await wrapper.get('form').trigger('submit');

		expect(wrapper.emitted('save')?.[0]?.[0]).toEqual(DEFAULTS);
	});

	it('offers no change to someone who cannot manage the workspace', () => {
		const wrapper = mountCard({ canManage: false });
		expect(wrapper.find('[data-testid="send-limits-edit"]').exists()).toBe(false);
	});
});
