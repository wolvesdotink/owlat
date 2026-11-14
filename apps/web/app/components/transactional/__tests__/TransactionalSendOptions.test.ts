/**
 * The transactional editor's send options: marking a data variable optional
 * and exempting the template from the per-recipient limit save at once, with
 * the template's id; someone who cannot manage templates sees the state but
 * cannot change it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import TransactionalSendOptions from '../TransactionalSendOptions.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const runs = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('@owlat/api', () => ({
	api: {
		transactional: {
			sendOptions: { setVariableOptional: 'setVariableOptional', setRecipientCapExempt: 'exempt' },
		},
	},
}));

let isAdmin = true;

beforeEach(() => {
	runs.calls.length = 0;
	isAdmin = true;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('usePermissions', () => ({ isAdmin: computed(() => isAdmin) }));
	vi.stubGlobal('useBackendOperation', (fn: string) => ({
		run: async (args: Record<string, unknown>) => {
			runs.calls.push({ fn, ...args });
			return { ok: true, result: null };
		},
		isLoading: computed(() => false),
	}));
});

const EMAIL_ID = 'email_1' as Id<'transactionalEmails'>;

function mountOptions(
	props: { optionalVariables?: string[]; isRecipientCapExempt?: boolean } = {}
) {
	return mount(TransactionalSendOptions, {
		props: {
			emailId: EMAIL_ID,
			variables: [
				{ key: 'orderNumber', type: 'string' },
				{ key: 'giftNote', type: 'string' },
			],
			optionalVariables: props.optionalVariables ?? [],
			isRecipientCapExempt: props.isRecipientCapExempt ?? false,
			showUnsubscribe: false,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiSwitch: {
					props: ['modelValue', 'label', 'disabled'],
					emits: ['update:modelValue'],
					template:
						'<button type="button" :disabled="disabled" :aria-pressed="modelValue" @click="$emit(\'update:modelValue\', !modelValue)">{{ label }}</button>',
				},
			},
		},
	});
}

describe('TransactionalSendOptions', () => {
	it('marks a variable optional, and a marked one required again', async () => {
		const wrapper = mountOptions({ optionalVariables: ['giftNote'] });
		expect(wrapper.get('[data-testid="variable-state-orderNumber"]').text()).toBe(
			'Required unless it has a fallback'
		);
		expect(wrapper.get('[data-testid="variable-state-giftNote"]').text()).toBe('Optional');

		await wrapper.get('[data-testid="variable-optional-orderNumber"]').trigger('click');
		await wrapper.get('[data-testid="variable-optional-giftNote"]').trigger('click');

		expect(runs.calls).toEqual([
			{ fn: 'setVariableOptional', id: EMAIL_ID, key: 'orderNumber', isOptional: true },
			{ fn: 'setVariableOptional', id: EMAIL_ID, key: 'giftNote', isOptional: false },
		]);
	});

	it('exempts the template from the per-recipient limit', async () => {
		const wrapper = mountOptions();
		await wrapper.get('[data-testid="recipient-limit-exempt"]').trigger('click');
		expect(runs.calls).toEqual([{ fn: 'exempt', id: EMAIL_ID, isExempt: true }]);
	});

	it('shows the state to a member who cannot manage templates, without letting them change it', () => {
		isAdmin = false;
		const wrapper = mountOptions({ isRecipientCapExempt: true });
		expect(wrapper.get('[data-testid="recipient-limit-exempt"]').attributes('aria-pressed')).toBe(
			'true'
		);
		expect(
			wrapper.get('[data-testid="recipient-limit-exempt"]').attributes('disabled')
		).toBeDefined();
		expect(
			wrapper.get('[data-testid="variable-optional-orderNumber"]').attributes('disabled')
		).toBeDefined();
	});
});
