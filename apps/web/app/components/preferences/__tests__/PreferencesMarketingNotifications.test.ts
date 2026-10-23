/**
 * Preferences → This device → Marketing notifications: one switch per kind
 * the server says can fire for this person, real copy, a write per toggle,
 * and a label saying the switches apply on every device.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PreferencesMarketingNotifications from '../PreferencesMarketingNotifications.vue';

const data = ref<{ kinds: string[]; enabled: Record<string, boolean> } | undefined>(undefined);
const save = vi.fn(async () => ({ ok: true }));

beforeEach(() => {
	vi.clearAllMocks();
	data.value = undefined;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('ref', ref);
	vi.stubGlobal('useConvexQuery', () => ({ data }));
	vi.stubGlobal('useBackendOperation', () => ({ run: save }));
});

function mountCard() {
	return mount(PreferencesMarketingNotifications, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiBadge: { template: '<span class="badge"><slot /></span>' },
				UiSwitch: {
					props: ['modelValue', 'id'],
					emits: ['update:modelValue'],
					template:
						'<input type="checkbox" :id="id" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
				},
			},
		},
	});
}

const ALL_ON = {
	campaignFinished: true,
	campaignReminder: true,
	deliveryHold: true,
	automationProblems: true,
	domainDns: true,
};

describe('PreferencesMarketingNotifications', () => {
	it('renders nothing until loaded, and nothing when no switch can fire', () => {
		expect(mountCard().find('#marketing-notifications').exists()).toBe(false);
		data.value = { kinds: [], enabled: ALL_ON };
		expect(mountCard().find('#marketing-notifications').exists()).toBe(false);
	});

	it('lists the switches that apply, in the server’s order, with their state', () => {
		data.value = {
			kinds: ['campaignFinished', 'campaignReminder'],
			enabled: { ...ALL_ON, campaignReminder: false },
		};
		const w = mountCard();
		const labels = w.findAll('label').map((label) => label.text());
		expect(labels).toEqual(['Campaign finished', 'Scheduled campaign about to send']);
		expect((w.get('#marketing-notify-campaignFinished').element as HTMLInputElement).checked).toBe(
			true
		);
		expect((w.get('#marketing-notify-campaignReminder').element as HTMLInputElement).checked).toBe(
			false
		);
		expect(w.find('#marketing-notify-domainDns').exists()).toBe(false);
		expectFullyLocalized(w);
	});

	it('says the switches belong to the account, on a page about this device', () => {
		data.value = { kinds: ['campaignFinished'], enabled: ALL_ON };
		const w = mountCard();
		expect(w.get('.badge').text()).toBe('All your devices');
		expect(w.text()).toContain('on every device');
	});

	it('saves a toggle for that switch only', async () => {
		data.value = {
			kinds: ['campaignFinished', 'deliveryHold', 'automationProblems', 'domainDns'],
			enabled: ALL_ON,
		};
		const w = mountCard();
		const input = w.get('#marketing-notify-domainDns');
		(input.element as HTMLInputElement).checked = false;
		await input.trigger('change');
		expect(save).toHaveBeenCalledWith({ preference: 'domainDns', enabled: false });
		expectFullyLocalized(w);
	});
});
