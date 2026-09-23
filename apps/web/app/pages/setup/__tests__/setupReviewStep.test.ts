// @vitest-environment happy-dom
/**
 * #773 — the review step names features by label under their pack, says in
 * one sentence what happens to secrets, and lists every launch blocker next to
 * the Launch button, each linked to its step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { getDefaultFlags } from '@owlat/shared/featureFlags';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import SetupReviewPage from '../review.vue';

const push = vi.fn();
let state: Map<string, Ref<unknown>>;

function install(seed: Record<string, unknown>) {
	sessionStorage.clear();
	state = new Map(Object.entries(seed).map(([key, value]) => [key, ref(value)]));
	installNuxtStubs({
		...i18nStubs,
		useState: (key: string, init?: () => unknown) => {
			if (!state.has(key)) state.set(key, ref(init?.()));
			return state.get(key);
		},
		useSetupWizard,
		useWizard,
		useRouter: () => ({ push }),
		useRoute: () => ({
			path: '/setup/review',
			fullPath: '/setup/review',
			query: {},
			params: {},
			meta: {},
		}),
	});
}

function mountStep() {
	return mountDashboardPage(SetupReviewPage, {
		stubs: {
			UiHeroField: true,
			UiStepIndicator: true,
			UiCard: { template: '<div><slot /></div>' },
			UiErrorAlert: true,
			UiInput: true,
			RestartProgress: true,
		},
	});
}

beforeEach(() => push.mockClear());

describe('setup review step', () => {
	it('names active features by label, grouped by pack, never by flag key', () => {
		install({
			setupFlags: {
				...getDefaultFlags(),
				campaigns: true,
				'campaigns.archive': true,
				inbox: true,
			},
		});
		const features = mountStep().get('[data-testid="review-features"]');
		expect(features.text()).toContain('Marketing');
		expect(features.text()).toContain('Marketing campaigns');
		expect(features.text()).not.toContain('campaigns.archive');
	});

	it('explains the generated secrets in one sentence and keeps the names in a disclosure', () => {
		install({});
		const wrapper = mountStep();
		expect(wrapper.text()).toContain(
			"We'll generate the secrets your server needs and save them to .env."
		);
		const details = wrapper.get('[data-testid="review-secrets"]');
		expect(details.element.tagName).toBe('DETAILS');
		expect(details.text()).toContain('BETTER_AUTH_SECRET');
	});

	it('lists every launch blocker next to Launch and links each to its step', async () => {
		install({
			setupFlags: { ...getDefaultFlags(), campaigns: true },
			setupEnv: {},
			setupAdmin: { email: '', name: '', password: '' },
			setupToken: '',
		});
		const wrapper = mountStep();
		expect(wrapper.get('[data-testid="launch-button"]').attributes('disabled')).toBeDefined();
		const list = wrapper.get('[data-testid="launch-blockers"]');
		expect(list.text()).toContain('Choose a delivery provider to continue');
		expect(list.text()).toContain('Create the admin account to continue');
		expect(list.text()).toContain('Enter the setup token to continue');

		await wrapper.get('[data-testid="launch-blocker-admin"]').trigger('click');
		expect(push).toHaveBeenCalledWith('/setup/admin');
		await wrapper.get('[data-testid="launch-blocker-provider"]').trigger('click');
		expect(push).toHaveBeenCalledWith('/setup/email');
	});

	it('enables Launch with no blocker list once everything is in place', () => {
		install({
			setupFlags: { ...getDefaultFlags(), campaigns: true },
			setupEnv: { EMAIL_PROVIDER: 'mta' },
			setupAdmin: { email: 'admin@example.com', name: '', password: 'a'.repeat(32) },
			setupToken: 'stk_abc',
		});
		const wrapper = mountStep();
		expect(wrapper.find('[data-testid="launch-blockers"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="launch-button"]').attributes('disabled')).toBeUndefined();
	});
});
