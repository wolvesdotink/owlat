// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@example/policy-pack',
			manifest: Object.freeze({
				id: 'policy-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['mail:read', 'send:gate']),
				flag: Object.freeze({
					default: false,
					requiredEnvVars: Object.freeze(['POLICY_TOKEN']),
				}),
			}),
		}),
		Object.freeze({
			packageName: '@example/zero-cap',
			manifest: Object.freeze({
				id: 'zero-cap',
				version: '1.0.0',
				capabilities: Object.freeze([]),
				flag: Object.freeze({ default: false }),
			}),
		}),
	]),
}));

import FeaturesPage from '../features.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const liveFlags = ref<Record<string, boolean>>({});
const configStatus = ref<Record<string, string[]> | undefined>({});
const isConfigStatusLoading = ref(false);
const configStatusError = ref<Error | null>(null);
const retryConfigStatus = vi.fn();
const setFeatureFlag = vi.fn();
const showToast = vi.fn();
let queryCall = 0;
let operationCall = 0;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useConvexQuery', () => {
		const call = queryCall++ % 3;
		if (call === 0) {
			return {
				data: liveFlags,
				isLoading: ref(false),
				error: ref(null),
				refetch: vi.fn(),
			};
		}
		if (call === 1) {
			return {
				data: ref(true),
				isLoading: ref(false),
				error: ref(null),
				refetch: vi.fn(),
			};
		}
		return {
			data: configStatus,
			isLoading: isConfigStatusLoading,
			error: configStatusError,
			refetch: retryConfigStatus,
		};
	});
	vi.stubGlobal('useBackendOperation', () => {
		const run = operationCall++ % 2 === 0 ? setFeatureFlag : vi.fn();
		return { run, isLoading: ref(false) };
	});
});

beforeEach(() => {
	queryCall = 0;
	operationCall = 0;
	liveFlags.value = { 'plugin.policy-pack': false, 'plugin.zero-cap': false };
	configStatus.value = {};
	isConfigStatusLoading.value = false;
	configStatusError.value = null;
	retryConfigStatus.mockReset();
	setFeatureFlag.mockReset().mockResolvedValue({ flags: {}, cascaded: [] });
	showToast.mockReset();
});

const passthroughStub = { template: '<section><slot name="header"/><slot/></section>' };
const confirmationStub = {
	props: ['open', 'title', 'confirmText'],
	emits: ['confirm', 'update:open'],
	template:
		'<div v-if="open" data-testid="confirmation"><h2>{{ title }}</h2><slot/><button data-testid="confirm" @click="$emit(\'confirm\')">{{ confirmText }}</button></div>',
};
const modalStub = {
	props: ['open', 'title'],
	emits: ['update:open'],
	template:
		'<div v-if="open" data-testid="modal"><h2>{{ title }}</h2><slot/><slot name="footer"/></div>',
};
const buttonStub = {
	template: '<button v-bind="$attrs"><slot/></button>',
};

function mountPage() {
	return mount(FeaturesPage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiQueryBoundary: passthroughStub,
				UiCard: passthroughStub,
				UiConfirmationDialog: confirmationStub,
				UiModal: modalStub,
				UiButton: buttonStub,
				UiIconBox: true,
				Icon: true,
				NuxtLink: true,
			},
		},
	});
}

const policySwitch = '[data-testid="feature-switch-plugin.policy-pack"]';
const zeroCapabilitySwitch = '[data-testid="feature-switch-plugin.zero-cap"]';
const aiDraftSwitch = '[data-testid="feature-switch-postbox.aiDraft"]';

/**
 * TWO SOURCES OF COPY ON ONE PAGE. Core flags and packs come from the catalog
 * (`sharedPkg.featureFlags.*`), because `@owlat/shared` keeps English for the
 * setup CLI; a bundled plugin's flag is MINTED at runtime and no shipped catalog
 * can hold its words, so it has to fall back to the definition's own label. A
 * regression in either direction — key paths for the core flags, or a blank
 * where the plugin's name belongs — is invisible to a source grep.
 */
describe('Settings Features — flag copy', () => {
	it("translates core flags and packs, and falls back to the plugin's own words", () => {
		const wrapper = mountPage();
		const text = wrapper.text();

		expect(text).toContain('Marketing campaigns');
		expect(text).toContain('Schedule and send broadcast campaigns to contacts and segments.');
		expect(text).toContain('Email Client');
		expect(text).toContain('Inbox, chat, and personal mail (Postbox) as one bundle.');
		expect(text).toContain('Policy Pack');
		expect(text).toContain('Bundled plugin from @example/policy-pack.');
		expectFullyLocalized(wrapper);
	});
});

describe('Settings Features — plugin approval behavior', () => {
	it('shows loading honestly and blocks only enablement', async () => {
		isConfigStatusLoading.value = true;
		configStatus.value = undefined;
		const enableWrapper = mountPage();
		expect(enableWrapper.find('[data-testid="plugin-config-status-loading"]').exists()).toBe(true);
		expect(enableWrapper.find(policySwitch).attributes('disabled')).toBeDefined();

		enableWrapper.unmount();
		queryCall = 0;
		operationCall = 0;
		liveFlags.value = { 'plugin.policy-pack': true, 'plugin.zero-cap': false };
		const disableWrapper = mountPage();
		expect(disableWrapper.find(policySwitch).attributes('disabled')).toBeUndefined();
		await disableWrapper.find(policySwitch).trigger('click');
		expect(setFeatureFlag).toHaveBeenCalledWith({ flag: 'plugin.policy-pack', value: false });
	});

	it('surfaces a retryable status error while leaving disablement available', async () => {
		configStatus.value = undefined;
		configStatusError.value = new Error('status offline');
		const wrapper = mountPage();
		expect(wrapper.find('[data-testid="plugin-config-status-error"]').text()).toContain(
			'status offline'
		);
		expect(wrapper.find(policySwitch).attributes('disabled')).toBeDefined();
		await wrapper.find('[data-testid="retry-plugin-config"]').trigger('click');
		expect(retryConfigStatus).toHaveBeenCalledOnce();
	});

	it('shows the exact missing environment requirements before approval', async () => {
		configStatus.value = {
			'plugin.policy-pack': ['POLICY_TOKEN', 'Grant: mail:read', 'Grant: send:gate'],
		};
		const wrapper = mountPage();
		await wrapper.find(policySwitch).trigger('click');

		expect(wrapper.find('[data-testid="modal"]').text()).toContain('POLICY_TOKEN');
		expect(wrapper.find('[data-testid="confirmation"]').exists()).toBe(false);
		expect(setFeatureFlag).not.toHaveBeenCalled();
	});

	it('confirms and submits exactly the capabilities declared by the plugin', async () => {
		const wrapper = mountPage();
		await wrapper.find(policySwitch).trigger('click');
		const confirmation = wrapper.find('[data-testid="confirmation"]');
		expect(confirmation.text()).toContain('mail:read');
		expect(confirmation.text()).toContain('send:gate');

		await confirmation.find('[data-testid="confirm"]').trigger('click');
		await flushPromises();
		expect(setFeatureFlag).toHaveBeenCalledWith({
			flag: 'plugin.policy-pack',
			value: true,
			approvedCapabilities: ['mail:read', 'send:gate'],
		});
	});

	it('enables a zero-capability plugin with an explicit empty approval', async () => {
		const wrapper = mountPage();
		await wrapper.find(zeroCapabilitySwitch).trigger('click');
		await flushPromises();

		expect(setFeatureFlag).toHaveBeenCalledWith({
			flag: 'plugin.zero-cap',
			value: true,
			approvedCapabilities: [],
		});
		expect(wrapper.find('[data-testid="confirmation"]').exists()).toBe(false);
	});

	it('disables without status data or capability approvals', async () => {
		liveFlags.value = { 'plugin.policy-pack': true, 'plugin.zero-cap': false };
		configStatus.value = undefined;
		configStatusError.value = new Error('status offline');
		const wrapper = mountPage();
		await wrapper.find(policySwitch).trigger('click');
		await flushPromises();

		expect(setFeatureFlag).toHaveBeenCalledWith({ flag: 'plugin.policy-pack', value: false });
	});
});

// postbox.aiDraft declares requires:['ai'] + requiresAny:[['postbox','mail.external']]
// (decision D2); the page renders the "Needs one of" hint generically from the
// registry, so any future any-of flag gets the same treatment for free.
describe('Settings Features — any-of dependency hint (requiresAny)', () => {
	it('disables the toggle with a "Needs one of" hint when no group member is on', () => {
		liveFlags.value = { ai: true };
		const wrapper = mountPage();
		const flagSwitch = wrapper.find(aiDraftSwitch);
		expect(flagSwitch.attributes('disabled')).toBeDefined();
		expect(flagSwitch.attributes('title')).toBe(
			'Needs one of: Personal mail (Postbox), Connect external mailbox'
		);
	});

	it('prefers the hard requires hint when a parent is also missing', () => {
		liveFlags.value = {};
		const wrapper = mountPage();
		const flagSwitch = wrapper.find(aiDraftSwitch);
		expect(flagSwitch.attributes('disabled')).toBeDefined();
		expect(flagSwitch.attributes('title')).toBe('Enable ai first');
	});

	it('enables through the external arm alone (postbox stays off)', async () => {
		liveFlags.value = { ai: true, 'mail.external': true };
		const wrapper = mountPage();
		const flagSwitch = wrapper.find(aiDraftSwitch);
		expect(flagSwitch.attributes('disabled')).toBeUndefined();
		expect(flagSwitch.attributes('title')).toBeUndefined();
		await flagSwitch.trigger('click');
		await flushPromises();
		expect(setFeatureFlag).toHaveBeenCalledWith({ flag: 'postbox.aiDraft', value: true });
	});
});
