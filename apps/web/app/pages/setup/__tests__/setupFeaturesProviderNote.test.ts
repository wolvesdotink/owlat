// @vitest-environment happy-dom
/**
 * The features step's delivery-provider note waits for a choice.
 *
 * Sending flags are on by default, so a note keyed only to "sending is on"
 * greets every operator before they have chosen anything — the review found it
 * as a red banner at the top of the step. It now appears, as a neutral note
 * under the Marketing pack, only once the operator switches sending on here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ref, type Ref } from 'vue';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import SetupFeaturesPage from '../features.vue';

// One keyed store, like Nuxt's `useState`, so the test and the page share the
// wizard's flag state.
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
	// Start from the registry defaults (campaigns + transactional on).
	useSetupWizard().flags.value = {};
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

const note = '[data-testid="setup-provider-note"]';
const marketingSwitch = 'button[aria-label="Toggle Marketing"]';

describe('setup features — provider note', () => {
	it('stays hidden on arrival even though sending is on by default', () => {
		const wrapper = mountPage();
		expect(wrapper.find(note).exists()).toBe(false);
		expect(wrapper.text()).not.toContain('A delivery provider is required');
	});

	it('appears under Marketing once the operator turns sending on', async () => {
		const wrapper = mountPage();
		// Default Marketing is partial (automations off): one click turns it all on.
		await wrapper.get(marketingSwitch).trigger('click');
		const shown = wrapper.find(note);
		expect(shown.exists()).toBe(true);
		expect(shown.text()).toContain('needs a delivery provider');
		expect(wrapper.get('[data-testid="feature-group-marketing"]').find(note).exists()).toBe(true);
	});

	it('does not appear when the choice turns sending off', async () => {
		useSetupWizard().flags.value = { campaigns: true, automations: true, transactional: true };
		const wrapper = mountPage();
		await wrapper.get(marketingSwitch).trigger('click');
		expect(wrapper.find(note).exists()).toBe(false);
	});
});
