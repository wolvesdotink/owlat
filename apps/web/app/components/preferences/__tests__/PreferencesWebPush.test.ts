// @vitest-environment happy-dom
/**
 * Preferences → This device → Push notifications.
 *
 * The card is the whole user-facing surface of Web Push, so the contract is
 * pinned here: it does not exist on the desktop app or without server keys,
 * the permission prompt comes only from the "Turn on" click, iPhone users are
 * told to install first, the device list marks this browser, and every string
 * is real copy rather than a key path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PreferencesWebPush from '../PreferencesWebPush.vue';

const state = {
	isDesktop: ref(false),
	support: ref<'supported' | 'needs-home-screen' | 'unsupported'>('supported'),
	permission: ref<NotificationPermission | 'unknown'>('default'),
	isProbed: ref(true),
	isLoading: ref(false),
	error: ref<Error | null>(null),
	isBusy: ref(false),
	isConfigured: ref(true),
	isEnabledHere: ref(false),
	isPrivate: ref(false),
	devices: ref<
		Array<{
			id: string;
			label: string;
			createdAt: number;
			lastSuccessAt: number | null;
			isCurrent: boolean;
		}>
	>([]),
};
const actions = {
	enable: vi.fn(async () => {}),
	disable: vi.fn(async () => {}),
	removeDevice: vi.fn(async () => {}),
	sendTest: vi.fn(async () => {}),
	setPrivate: vi.fn(async () => {}),
	refetch: vi.fn(),
};
const mailEnabled = ref(true);

beforeEach(() => {
	vi.clearAllMocks();
	state.isDesktop.value = false;
	state.support.value = 'supported';
	state.permission.value = 'default';
	state.isProbed.value = true;
	state.isLoading.value = false;
	state.error.value = null;
	state.isConfigured.value = true;
	state.isEnabledHere.value = false;
	state.isPrivate.value = false;
	state.devices.value = [];
	mailEnabled.value = true;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('ref', ref);
	vi.stubGlobal('useWebPush', () => ({ ...state, ...actions }));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) => mailEnabled.value && flag === 'postbox',
	}));
});

function mountCard() {
	return mount(PreferencesWebPush, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiSkeleton: true,
				UiBadge: { template: '<span class="badge"><slot /></span>' },
				UiButton: {
					emits: ['click'],
					template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
				},
				UiSwitch: {
					props: ['modelValue'],
					emits: ['update:modelValue'],
					template:
						'<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
				},
				UiErrorAlert: {
					props: ['message', 'actionLabel'],
					emits: ['action'],
					template:
						'<div class="error">{{ message }}<button @click="$emit(\'action\')">{{ actionLabel }}</button></div>',
				},
				PostboxNotificationSettings: { template: '<div data-testid="rules" />' },
			},
		},
	});
}

describe('PreferencesWebPush', () => {
	it('renders nothing on the desktop app or when the server has no keys', () => {
		state.isDesktop.value = true;
		expect(mountCard().find('[data-testid="web-push-settings"]').exists()).toBe(false);
		state.isDesktop.value = false;
		state.isConfigured.value = false;
		const hidden = mountCard();
		expect(hidden.find('[data-testid="web-push-settings"]').exists()).toBe(false);
		expect(hidden.find('[data-testid="rules"]').exists()).toBe(false);
	});

	it('offers "Turn on" and only asks for permission when it is clicked', async () => {
		const w = mountCard();
		expect(actions.enable).not.toHaveBeenCalled();
		expect(w.get('[data-testid="web-push-status"]').text()).toContain('Off');
		await w.get('[data-testid="web-push-enable"]').trigger('click');
		expect(actions.enable).toHaveBeenCalledTimes(1);
		expectFullyLocalized(w);
	});

	it('shows the on state with a way to turn it off', async () => {
		state.isEnabledHere.value = true;
		state.permission.value = 'granted';
		const w = mountCard();
		expect(w.find('[data-testid="web-push-enable"]').exists()).toBe(false);
		expect(w.get('[data-testid="web-push-status"]').text()).toContain('On');
		await w.get('[data-testid="web-push-disable"]').trigger('click');
		expect(actions.disable).toHaveBeenCalledTimes(1);
	});

	it('tells iPhone and iPad users to add Owlat to the Home Screen first', () => {
		state.support.value = 'needs-home-screen';
		const w = mountCard();
		expect(w.find('[data-testid="web-push-enable"]').exists()).toBe(false);
		expect(w.get('[data-testid="web-push-ios-hint"]').text()).toContain('Add to Home Screen');
		expectFullyLocalized(w);
	});

	it('explains a blocked permission instead of offering a button that cannot work', () => {
		state.permission.value = 'denied';
		const w = mountCard();
		expect(w.find('[data-testid="web-push-enable"]').exists()).toBe(false);
		expect(w.text()).toContain('site settings');
	});

	it('lists every device, marks this one, and tests or removes them', async () => {
		state.devices.value = [
			{
				id: 'd1',
				label: 'Chrome on macOS',
				createdAt: Date.now(),
				lastSuccessAt: Date.now(),
				isCurrent: true,
			},
			{
				id: 'd2',
				label: 'Safari on iPhone',
				createdAt: Date.now(),
				lastSuccessAt: null,
				isCurrent: false,
			},
		];
		const w = mountCard();
		const rows = w.findAll('[data-testid="web-push-devices"] li');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.text()).toContain('This device');
		expect(rows[0]!.text()).toContain('last notified');
		expect(rows[1]!.text()).not.toContain('This device');
		await rows[1]!.findAll('button')[0]!.trigger('click');
		expect(actions.sendTest).toHaveBeenCalledWith('d2');
		await rows[1]!.findAll('button')[1]!.trigger('click');
		expect(actions.removeDevice).toHaveBeenCalledWith('d2');
		expectFullyLocalized(w);
	});

	it('says so when no device notifies yet', () => {
		expect(mountCard().get('[data-testid="web-push-no-devices"]').text()).toContain('No devices');
	});

	it('writes the private switch through', async () => {
		const w = mountCard();
		await w.get('#web-push-private').setValue(true);
		expect(actions.setPrivate).toHaveBeenCalledWith(true);
	});

	it('shows the notification rules under the card only where mail exists', () => {
		expect(mountCard().find('[data-testid="rules"]').exists()).toBe(true);
		mailEnabled.value = false;
		expect(mountCard().find('[data-testid="rules"]').exists()).toBe(false);
	});

	it('offers a retry when the devices could not be loaded', async () => {
		state.error.value = new Error('boom');
		state.isConfigured.value = false;
		const w = mountCard();
		expect(w.get('.error').text()).toContain('couldn’t be loaded');
		await w.get('.error button').trigger('click');
		expect(actions.refetch).toHaveBeenCalled();
	});
});
