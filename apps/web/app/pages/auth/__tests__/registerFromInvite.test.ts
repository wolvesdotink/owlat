/**
 * Creating an account from an invitation leads back to that invitation.
 *
 * The new account has to confirm its email before the invitation can be
 * accepted, so the confirmation link must return to the invitation, not to the
 * root. When the instance withholds the session until the email is confirmed,
 * the form says so instead of sending the person to a page that asks them to
 * sign in again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AuthShell from '~/components/auth/AuthShell.vue';
import AuthPasswordInput from '~/components/auth/AuthPasswordInput.vue';
import AuthLegalFooter from '~/components/auth/AuthLegalFooter.vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiHeroField from '@owlat/ui/components/ui/HeroField.vue';
import UiErrorAlert from '@owlat/ui/components/ui/ErrorAlert.vue';
import RegisterPage from '../register.vue';

const invitePath = '/invite/accept?id=inv-1';

let signUpResult: { token: string | null; user: { id: string } } = {
	token: 'session-token',
	user: { id: 'user-1' },
};
const signUpWithEmail = vi.fn(async (..._args: unknown[]) => signUpResult);
const routerPush = vi.fn();
const createUserProfile = vi.fn(async (_args: unknown) => ({ ok: true }));

function mountPage(deploymentMode = 'selfhost') {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({
			path: '/auth/register',
			fullPath: '/auth/register',
			query: { redirect: invitePath },
			hash: '',
			params: {},
			meta: {},
		}),
		useRouter: () => ({ push: routerPush, replace: vi.fn() }),
		safeRedirect: (target: unknown, fallback: string) =>
			typeof target === 'string' ? target : fallback,
		useRuntimeConfig: () => ({ public: { deploymentMode, companyName: '' } }),
		useRecipientSender: () => ({ senderName: ref(null) }),
		useAuth: () => ({ isAuthenticated: ref(false), signUpWithEmail }),
		useBackendOperation: () => ({ run: createUserProfile }),
	});
	return mount(RegisterPage, {
		global: {
			plugins: [createTestI18n()],
			components: {
				AuthShell,
				AuthPasswordInput,
				AuthLegalFooter,
				UiInput,
				UiHeroField,
				UiButton,
				UiErrorAlert,
			},
			stubs: { UiIconBox: true },
		},
	});
}

async function fillAndSubmit(wrapper: ReturnType<typeof mountPage>, acceptTerms = true) {
	await wrapper.find('#name').setValue('New Colleague');
	await wrapper.find('#email').setValue('new@owlat.example');
	await wrapper.find('#password').setValue('a-long-enough-password');
	const terms = wrapper.find('input[type="checkbox"]');
	if (acceptTerms && terms.exists()) await terms.setValue(true);
	await wrapper.find('form').trigger('submit');
	await flushPromises();
}

beforeEach(() => {
	signUpResult = { token: 'session-token', user: { id: 'user-1' } };
	signUpWithEmail.mockClear();
	routerPush.mockClear();
	createUserProfile.mockClear();
});

describe('registering from an invitation', () => {
	it('points the confirmation link back at the invitation', async () => {
		const wrapper = mountPage();
		await fillAndSubmit(wrapper);

		expect(signUpWithEmail).toHaveBeenCalledWith(
			'new@owlat.example',
			'a-long-enough-password',
			'New Colleague',
			{ callbackURL: invitePath }
		);
		expect(routerPush).toHaveBeenCalledWith(invitePath);
	});

	it('asks the person to check their inbox when the server withholds the session', async () => {
		signUpResult = { token: null, user: { id: 'user-1' } };
		const wrapper = mountPage();
		await fillAndSubmit(wrapper);

		expect(routerPush).not.toHaveBeenCalled();
		// Without a session the profile mutation is refused, and the operation
		// module answers a refusal by sending the person to sign-in.
		expect(createUserProfile).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('Check your inbox');
		expect(wrapper.text()).toContain('new@owlat.example');
	});
});

describe('the terms checkbox', () => {
	it('is not asked on a self-hosted instance, which publishes no terms', async () => {
		const wrapper = mountPage('selfhost');
		expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);

		await fillAndSubmit(wrapper, false);
		expect(signUpWithEmail).toHaveBeenCalled();
	});

	it('blocks the hosted sign-up until the terms are accepted, and ties the error to the box', async () => {
		const wrapper = mountPage('hosted');
		await fillAndSubmit(wrapper, false);

		expect(signUpWithEmail).not.toHaveBeenCalled();
		const box = wrapper.find('input[type="checkbox"]');
		expect(box.attributes('aria-invalid')).toBe('true');
		const errorId = box.attributes('aria-describedby');
		expect(errorId).toBeTruthy();
		expect(wrapper.find(`#${errorId}`).text()).not.toBe('');
	});
});
