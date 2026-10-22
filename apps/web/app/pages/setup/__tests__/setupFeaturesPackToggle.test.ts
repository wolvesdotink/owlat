/**
 * What clicking a pack does from each state, end to end on the setup step.
 *
 * The pack control reads as a mixed checkbox while only some of its features
 * are on. Activating it from mixed turns the whole pack on (the same as from
 * unchecked); only a fully-on pack turns off. The a11y role change must not
 * move that.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ref, type Ref } from 'vue';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import SetupFeaturesPage from '../features.vue';

let state: Map<string, Ref<unknown>>;

beforeEach(() => {
	localStorage.clear();
	state = new Map();
	installNuxtStubs({
		...i18nStubs,
		useState: <T>(key: string, init?: () => T) => {
			if (!state.has(key)) state.set(key, ref(init?.()));
			return state.get(key) as Ref<T>;
		},
		useSetupWizard,
		useWizard,
		useRoute: () => ({ path: '/setup', fullPath: '/setup', query: {}, params: {}, meta: {} }),
	});
	useSetupWizard().flags.value = { campaigns: true, automations: false, transactional: false };
});

function mountPage() {
	return mountDashboardPage(SetupFeaturesPage, {
		stubs: {
			UiCard: { template: '<div><slot /></div>' },
			UiHeroField: true,
			UiStepIndicator: true,
		},
	});
}

const marketingPack = 'button[aria-label="Toggle Marketing"]';

describe('setup features — pack toggle from each state', () => {
	it('turns a mixed pack fully on, then fully off', async () => {
		const wrapper = mountPage();
		expect(wrapper.get(marketingPack).attributes('aria-checked')).toBe('mixed');

		await wrapper.get(marketingPack).trigger('click');
		expect(wrapper.get(marketingPack).attributes('aria-checked')).toBe('true');
		expect(useSetupWizard().flags.value).toMatchObject({
			campaigns: true,
			automations: true,
			transactional: true,
		});

		await wrapper.get(marketingPack).trigger('click');
		expect(wrapper.get(marketingPack).attributes('aria-checked')).toBe('false');
		expect(useSetupWizard().flags.value).toMatchObject({
			campaigns: false,
			automations: false,
			transactional: false,
		});

		await wrapper.get(marketingPack).trigger('click');
		expect(wrapper.get(marketingPack).attributes('aria-checked')).toBe('true');
	});
});
