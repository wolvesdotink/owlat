// @vitest-environment happy-dom
/**
 * ACCESSIBILITY PASS ON THE FOUR AUTH SCREENS.
 *
 * Every one of them is a form, and forms are where the failures bite hardest:
 * an input whose label is only a placeholder, a validation error rendered as
 * red text with no programmatic tie to the field it describes, a submit button
 * that loses its name while it spins. All four states are audited — the resting
 * form AND the form after a failed submit, because the error branch is markup
 * that only exists once something has gone wrong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auditA11y, installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
// The shared hero shell carries the page's <h1>, so it has to be resolved for
// the audit to see the heading — an unresolved wrapper drops its named slots.
import AuthShell from '~/components/auth/AuthShell.vue';
import LoginPage from '../login.vue';
import RegisterPage from '../register.vue';
import ForgotPasswordPage from '../forgot-password.vue';
import ResetPasswordPage from '../reset-password.vue';

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => ({
			path: '/auth/login',
			fullPath: '/auth/login',
			// The reset flow refuses to render its form without a token, and the
			// register page shows its "invite only" notice unless the redirect
			// points at an invitation — both forms are the surface under audit.
			query: { token: 'reset-token', redirect: '/invite/accept' },
			params: {},
			meta: {},
		}),
		// `safeRedirect` is an auto-imported util the login page calls on submit.
		safeRedirect: (target: unknown, fallback: string) =>
			typeof target === 'string' ? target : fallback,
	});
});

// `invalidFields` is how many inputs the page marks `aria-invalid` after an
// empty submit — one per validated field. Asserting the count, not just that
// the word "required" appeared somewhere, is what makes the error branch a real
// audit: a page that validated only its first field would otherwise pass while
// the rest of the error markup went unscanned.
const pages = [
	{ name: 'login', component: LoginPage, loaded: 'Sign in', invalidFields: 2 },
	{ name: 'register', component: RegisterPage, loaded: 'Create', invalidFields: 3 },
	{ name: 'forgot password', component: ForgotPasswordPage, loaded: 'Reset', invalidFields: 1 },
	{ name: 'reset password', component: ResetPasswordPage, loaded: 'password', invalidFields: 2 },
] as const;

describe.each(pages)('$name page — accessibility', ({ component, loaded, invalidFields }) => {
	it('has no axe violations at rest', async () => {
		const violations = await auditA11y(component, {
			global: { plugins: [createTestI18n()], components: { AuthShell } },
			prepare: (wrapper) => expect(wrapper.text()).toContain(loaded),
		});
		expect(violations).toEqual([]);
	});

	it('has no axe violations once every field has failed validation', async () => {
		const violations = await auditA11y(component, {
			global: { plugins: [createTestI18n()], components: { AuthShell } },
			// Submitting the empty form is the shortest path to the error branch:
			// each field's validator fires and renders its message.
			prepare: async (wrapper) => {
				await wrapper.find('form').trigger('submit');
				// Guards the audit against a form that silently accepted the empty
				// submit — then this test would be scanning the resting page twice.
				expect(wrapper.text()).toContain('required');
				expect(wrapper.findAll('[aria-invalid="true"]')).toHaveLength(invalidFields);
			},
		});
		expect(violations).toEqual([]);
	});
});
