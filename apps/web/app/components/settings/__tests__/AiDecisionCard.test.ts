import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AiDecisionCard from '../AiDecisionCard.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountCard(featureState: 'loading' | 'error' | 'enabled' | 'disabled') {
	return mount(AiDecisionCard, {
		props: {
			enabled: true,
			kind: 'typesafe',
			modelChoice: 'jev-1.13.0',
			modelCustom: '',
			baseUrl: '',
			apiKey: '',
			fallbackEnabled: false,
			consent: false,
			options: [],
			requiresKey: true,
			modelOptions: [],
			endpointHost: 'api.typesafe.ai',
			storedKeySet: true,
			error: null,
			keyHint: null,
			consentOwed: false,
			degradedReasons: [],
			thresholdsInert: false,
			fallbackSurfaces: [],
			thresholds: [],
			testState: { status: 'idle' },
			health: null,
			healthHours: 24,
			isTesting: false,
			isSaving: false,
			canTest: true,
			featureState,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiCard: { template: '<section><slot /></section>' },
				UiDisclosure: { template: '<div><slot /></div>' },
				UiButton: {
					props: ['disabled'],
					template: '<button :disabled="disabled"><slot /></button>',
				},
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiSelect: true,
				UiInput: true,
				UiCheckbox: true,
				UiSwitch: true,
				Icon: true,
				SettingsAiKeyField: true,
				SettingsAiModelPicker: true,
			},
		},
	});
}

describe('decision feature status', () => {
	it('explains the separate feature toggle even with a saved provider and key', () => {
		const wrapper = mountCard('disabled');
		expect(wrapper.get('button').element.disabled).toBe(true);
		expect(wrapper.get('[role="status"]').text()).toContain('enable AI and Decision plane');
		expect(wrapper.get('a').attributes('href')).toBe('/dashboard/admin/instance/features');
	});

	it.each(['loading', 'error'] as const)(
		'refuses tests while the feature status is %s',
		(state) => {
			const wrapper = mountCard(state);
			expect(wrapper.get('button').element.disabled).toBe(true);
			expect(wrapper.get('[role="status"]').text()).not.toContain(
				'Decision requests are enabled in Features.'
			);
		}
	);

	it('responds to the live flag and still requires saved settings', async () => {
		const wrapper = mountCard('disabled');
		await wrapper.setProps({ featureState: 'enabled' });
		expect(wrapper.get('button').element.disabled).toBe(false);
		await wrapper.get('button').trigger('click');
		expect(wrapper.emitted('test')).toHaveLength(1);
		await wrapper.setProps({ canTest: false });
		expect(wrapper.get('button').element.disabled).toBe(true);
		await wrapper.setProps({
			canTest: true,
			featureState: 'disabled',
			testState: { status: 'ok' },
		});
		expect(wrapper.get('button').element.disabled).toBe(true);
		expect(wrapper.text()).not.toContain('the key, the endpoint and the model version all work');
	});
});
