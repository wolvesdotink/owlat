// @vitest-environment happy-dom
/**
 * #768 / #769 — the auth screens share one password rule and one door.
 *
 *  - Sign-in never judges a password's length: that is the server's call, and an
 *    account created under an older minimum must still reach it.
 *  - Register and reset read the shared minimum, so their message matches the
 *    server's rule instead of restating a number.
 *  - Every password field can be revealed.
 *  - Reset links back to sign-in.
 *  - "Create an account" only appears when the visitor came from an invitation,
 *    the one case in which the register page is not a locked door.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { MIN_PASSWORD_LENGTH } from '@owlat/shared/passwordPolicy';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AuthShell from '~/components/auth/AuthShell.vue';
import AuthPasswordInput from '~/components/auth/AuthPasswordInput.vue';
import AuthLegalFooter from '~/components/auth/AuthLegalFooter.vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import UiHeroField from '@owlat/ui/components/ui/HeroField.vue';
import LoginPage from '../login.vue';
import RegisterPage from '../register.vue';
import ResetPasswordPage from '../reset-password.vue';

const signInWithEmail = vi.fn(async () => ({}));

function stubs(query: Record<string, string>, publicConfig: Record<string, unknown> = {}) {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({ path: '/auth/login', fullPath: '/auth/login', query, params: {}, meta: {} }),
		safeRedirect: (target: unknown, fallback: string) =>
			typeof target === 'string' ? target : fallback,
		useRuntimeConfig: () => ({
			public: { deploymentMode: 'selfhost', companyName: '', ...publicConfig },
		}),
		useAuth: () => ({
			isAuthenticated: ref(false),
			signInWithEmail,
			completeTwoFactorSignIn: vi.fn(),
			signUpWithEmail: vi.fn(),
			resetPassword: vi.fn(),
		}),
	});
}

function mountPage(component: object) {
	return mount(component, {
		global: {
			plugins: [createTestI18n()],
			components: { AuthShell, AuthPasswordInput, AuthLegalFooter, UiInput, UiHeroField },
		},
	});
}

beforeEach(() => {
	signInWithEmail.mockClear();
});

describe('sign-in', () => {
	it('sends a short password to the server instead of rejecting it on the client', async () => {
		stubs({});
		const wrapper = mountPage(LoginPage);
		await wrapper.find('#email').setValue('ada@example.com');
		await wrapper.find('#password').setValue('short');
		await wrapper.find('form').trigger('submit');
		await flushPromises();

		expect(signInWithEmail).toHaveBeenCalledWith('ada@example.com', 'short');
		expect(wrapper.find('[aria-invalid="true"]').exists()).toBe(false);
	});

	it('does not offer "Create an account" on an invite-only instance', () => {
		stubs({});
		const wrapper = mountPage(LoginPage);
		expect(wrapper.find('a[href^="/auth/register"]').exists()).toBe(false);
	});

	it('offers "Create an account" when the visitor came from an invitation', () => {
		stubs({ redirect: '/invite/accept?id=abc' });
		const wrapper = mountPage(LoginPage);
		expect(wrapper.text()).toContain('Create one');
	});

	it('greets visitors with the workspace name when the operator configured one', () => {
		stubs({}, { companyName: 'Northwind Studio' });
		const wrapper = mountPage(LoginPage);
		expect(wrapper.find('h1').text()).toBe('Northwind Studio');
		// The operator's own legal pages exist, so the footer links to them.
		expect(wrapper.find('a[href="/imprint"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Powered by');
	});

	it('shows "Powered by Owlat" instead of empty legal pages when none are configured', () => {
		stubs({});
		const wrapper = mountPage(LoginPage);
		expect(wrapper.text()).toContain('Powered by Owlat');
		expect(wrapper.find('a[href="/imprint"]').exists()).toBe(false);
	});

	it('lets the password be revealed', async () => {
		stubs({});
		const wrapper = mountPage(LoginPage);
		const input = wrapper.find('#password');
		expect(input.attributes('type')).toBe('password');

		const toggle = wrapper.find('[data-testid="password-visibility-toggle"]');
		expect(toggle.attributes('aria-pressed')).toBe('false');
		await toggle.trigger('click');
		expect(input.attributes('type')).toBe('text');
		expect(toggle.attributes('aria-pressed')).toBe('true');
	});
});

describe('register', () => {
	it('applies the shared minimum and names it in the error', async () => {
		stubs({ redirect: '/invite/accept' });
		const wrapper = mountPage(RegisterPage);
		await wrapper.find('#password').setValue('a'.repeat(MIN_PASSWORD_LENGTH - 1));
		await wrapper.find('#password').trigger('blur');
		expect(wrapper.text()).toContain(`at least ${MIN_PASSWORD_LENGTH} characters`);

		await wrapper.find('#password').setValue('a'.repeat(MIN_PASSWORD_LENGTH));
		await wrapper.find('#password').trigger('blur');
		expect(wrapper.find('#password').attributes('aria-invalid')).toBeUndefined();
	});
});

describe('reset password', () => {
	it('applies the shared minimum', async () => {
		stubs({ token: 'reset-token' });
		const wrapper = mountPage(ResetPasswordPage);
		expect(wrapper.text()).toContain(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
		await wrapper.find('#new-password').setValue('a'.repeat(MIN_PASSWORD_LENGTH - 1));
		await wrapper.find('#new-password').trigger('blur');
		expect(wrapper.find('#new-password').attributes('aria-invalid')).toBe('true');
	});

	it('links back to sign-in', () => {
		stubs({ token: 'reset-token' });
		const wrapper = mountPage(ResetPasswordPage);
		const back = wrapper.find('a[href="/auth/login"]');
		expect(back.exists()).toBe(true);
		expect(back.text()).toBe('Back to sign in');
	});
});
