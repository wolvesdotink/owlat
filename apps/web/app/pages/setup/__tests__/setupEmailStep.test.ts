// @vitest-environment happy-dom
/**
 * #772 — the email step says what it does, hints only while nothing is picked,
 * marks the chosen provider as selected, and no longer asks for hand-written
 * JSON (per-IP EHLO overrides stay an `.env` setting).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ref, type Ref } from 'vue';
import { getDefaultFlags } from '@owlat/shared/featureFlags';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import { SETUP_CHOICE_SELECTED } from '~/utils/setupChoiceCard';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import SetupEmailPage from '../email.vue';

let state: Map<string, Ref<unknown>>;

function install(flags: Record<string, boolean>) {
	sessionStorage.clear();
	state = new Map([['setupFlags', ref({ ...getDefaultFlags(), ...flags })]]);
	installNuxtStubs({
		...i18nStubs,
		useState: (key: string, init?: () => unknown) => {
			if (!state.has(key)) state.set(key, ref(init?.()));
			return state.get(key);
		},
		useSetupWizard,
		useWizard,
		useRoute: () => ({
			path: '/setup/email',
			fullPath: '/setup/email',
			query: {},
			params: {},
			meta: {},
		}),
	});
}

function mountStep() {
	return mountDashboardPage(SetupEmailPage, {
		stubs: {
			UiHeroField: true,
			UiStepIndicator: true,
			UiCard: { template: '<div><slot /></div>' },
			UiErrorAlert: true,
			UiSelect: true,
			UiSwitch: true,
		},
		components: { UiInput },
	});
}

const NO_BULK = { campaigns: false, transactional: false, automations: false, inbox: false };

describe('setup email step', () => {
	beforeEach(() => install(NO_BULK));

	it('introduces the step without miscounting the options', () => {
		const wrapper = mountStep();
		expect(wrapper.text()).toContain('Pick how Owlat sends mail.');
		expect(wrapper.text()).not.toMatch(/Three honest ways/);
	});

	it('shows a neutral hint while no provider is picked, and hides it once one is', async () => {
		const wrapper = mountStep();
		const hint = wrapper.get('[data-testid="setup-provider-hint"]');
		expect(hint.classes()).not.toContain('text-error');
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);

		await wrapper.get('input[type="radio"][value="mta"]').setValue(true);
		expect(wrapper.find('[data-testid="setup-provider-hint"]').exists()).toBe(false);
	});

	it('marks the selected provider with the brand-tinted selected style', async () => {
		const wrapper = mountStep();
		await wrapper.get('input[type="radio"][value="mta"]').setValue(true);
		const card = wrapper.get('input[type="radio"][value="mta"]').element.closest('label');
		for (const cls of SETUP_CHOICE_SELECTED.split(' ')) {
			expect(card?.classList.contains(cls)).toBe(true);
		}
		expect(card?.classList.contains('bg-(--surface-2-selected)')).toBe(false);
	});

	it('does not ask for per-IP EHLO overrides as JSON', async () => {
		const wrapper = mountStep();
		await wrapper.get('input[type="radio"][value="mta"]').setValue(true);
		expect(wrapper.text()).toContain('Outbound IP identity');
		expect(wrapper.text()).not.toMatch(/EHLO overrides|JSON/);
	});
});

describe('setup email step with bulk sending on', () => {
	beforeEach(() => install({ campaigns: true }));

	it('shows no banner, because a provider is already preselected', () => {
		const wrapper = mountStep();
		expect(wrapper.find('[data-testid="setup-provider-hint"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('A delivery provider is required');
	});
});
