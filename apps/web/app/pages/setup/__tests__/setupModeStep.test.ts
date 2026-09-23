// @vitest-environment happy-dom
/**
 * #770 — the mode step asks what the team wants to do, recommends "Both", and
 * keeps the eight operator presets behind an "Advanced" disclosure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import { outcomeFlags } from '~/composables/setupWizardOutcomes';
import { operatingModeFlags } from '@owlat/shared/operatingModes';
import { SETUP_CHOICE_SELECTED } from '~/utils/setupChoiceCard';
import UiBadge from '@owlat/ui/components/ui/Badge.vue';
import UiSwitch from '@owlat/ui/components/ui/Switch.vue';
import SetupModePage from '../mode.vue';

const push = vi.fn();
// One store per test, so the page and the assertions read the same wizard state.
let state: Map<string, Ref<unknown>>;

beforeEach(() => {
	push.mockClear();
	sessionStorage.clear();
	state = new Map();
	installNuxtStubs({
		useState: (key: string, init?: () => unknown) => {
			if (!state.has(key)) state.set(key, ref(init?.()));
			return state.get(key);
		},
		...i18nStubs,
		useSetupWizard,
		useWizard,
		useRouter: () => ({ push }),
		useRoute: () => ({
			path: '/setup/mode',
			fullPath: '/setup/mode',
			query: {},
			params: {},
			meta: {},
		}),
	});
});

function mountStep() {
	return mountDashboardPage(SetupModePage, {
		stubs: { UiHeroField: true, UiStepIndicator: true },
		components: { UiBadge, UiSwitch },
	});
}

describe('setup mode step', () => {
	it('preselects "Both" and marks it with the brand-tinted selected style', () => {
		const wrapper = mountStep();
		const both = wrapper.get('[data-testid="setup-outcome-both"]');
		expect(both.get('input').element.checked).toBe(true);
		for (const cls of SETUP_CHOICE_SELECTED.split(' ')) expect(both.classes()).toContain(cls);
		expect(both.classes()).not.toContain('bg-(--surface-2-selected)');
	});

	it('continues with the recommended answer without a click', async () => {
		const wrapper = mountStep();
		await wrapper.get('form').trigger('submit');
		expect(useSetupWizard().flags.value).toEqual(outcomeFlags('both', false));
		expect(push).toHaveBeenCalledWith('/setup/features');
	});

	it('applies the chosen answer and the AI drafting option', async () => {
		const wrapper = mountStep();
		await wrapper.get('[data-testid="setup-outcome-conversations"] input').setValue(true);
		const aiDrafts = wrapper.get('[data-testid="setup-outcome-ai-drafts"] [role="switch"]');
		expect(aiDrafts.attributes('aria-checked')).toBe('false');
		await aiDrafts.trigger('click');
		expect(aiDrafts.attributes('aria-checked')).toBe('true');
		await wrapper.get('form').trigger('submit');
		expect(useSetupWizard().flags.value).toEqual(outcomeFlags('conversations', true));
	});

	it('keeps flags tuned on the Features step when the same answer is continued again', async () => {
		const wrapper = mountStep();
		await wrapper.get('form').trigger('submit');
		const wizard = useSetupWizard();
		// The operator tunes a flag on the next step, then comes back here.
		wizard.flags.value = { ...wizard.flags.value, chat: !wizard.flags.value.chat };
		const tuned = { ...wizard.flags.value };
		await wrapper.get('form').trigger('submit');
		expect(wizard.flags.value).toEqual(tuned);

		// A different answer does start the flags over.
		await wrapper.get('[data-testid="setup-outcome-sending"] input').setValue(true);
		await wrapper.get('form').trigger('submit');
		expect(wizard.flags.value).toEqual(outcomeFlags('sending', false));
	});

	it('does not offer AI drafting when the team only sends', async () => {
		const wrapper = mountStep();
		await wrapper.get('[data-testid="setup-outcome-sending"] input').setValue(true);
		expect(wrapper.find('[data-testid="setup-outcome-ai-drafts"]').exists()).toBe(false);
	});

	it('keeps the eight presets behind "Advanced: pick a preset"', async () => {
		const wrapper = mountStep();
		const details = wrapper.get('[data-testid="setup-presets"]');
		expect(details.element.tagName).toBe('DETAILS');
		expect(details.get('summary').text()).toBe('Advanced: pick a preset');
		expect(details.findAll('[data-testid^="setup-preset-"]')).toHaveLength(8);

		await details.get('[data-testid="setup-preset-hosted_mail"]').trigger('click');
		expect(useSetupWizard().flags.value).toEqual(operatingModeFlags('hosted_mail'));
		expect(push).toHaveBeenCalledWith('/setup/features');
	});
});
