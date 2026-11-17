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
const error = ref<Error | null>(null);
const refetch = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	data.value = undefined;
	error.value = null;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('ref', ref);
	vi.stubGlobal('useConvexQuery', () => ({ data, error, refetch }));
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
	postmasterMail: true,
};

describe('PreferencesMarketingNotifications', () => {
	it('keeps the card with a retry when the read fails, instead of vanishing', async () => {
		error.value = new Error('boom');
		const w = mountCard();
		expect(w.find('#marketing-notifications').exists()).toBe(true);
		const boundary = w.findComponent({ name: 'QueryBoundary' });
		expect(boundary.exists()).toBe(true);
		boundary.vm.$emit('retry');
		expect(refetch).toHaveBeenCalledTimes(1);
	});

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

	it('offers the postmaster and abuse mail switch to whoever the server lists it for', () => {
		data.value = { kinds: ['domainDns', 'postmasterMail'], enabled: ALL_ON };
		const w = mountCard();
		expect(w.findAll('label').map((label) => label.text())).toEqual([
			'Sending domain DNS broken',
			'Postmaster and abuse mail',
		]);
		expect(w.text()).toContain('writes to postmaster@ or abuse@');
		expectFullyLocalized(w);
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
