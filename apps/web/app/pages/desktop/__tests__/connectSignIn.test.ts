// @vitest-environment happy-dom
/**
 * The desktop connect handshake validates its credentials like the sign-in
 * page: per field, with the same messages. It used to accept any non-empty
 * email and answer an empty field with one combined sentence, so a typo in the
 * address went to the server as a sign-in attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref, useSlots } from 'vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import AuthPasswordInput from '~/components/auth/AuthPasswordInput.vue';
import AuthTwoFactorStageForm from '~/components/auth/TwoFactorStageForm.vue';
import { useAuthForm } from '~/composables/useAuthForm';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ConnectPage from '../connect.vue';

const signInWithEmail = vi.fn(async (): Promise<Record<string, unknown>> => ({}));

let mounted: VueWrapper[] = [];

beforeEach(() => {
	signInWithEmail.mockClear();
	// `UiInput` reads its icon slots through the auto-imported `useSlots`.
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useAuthForm, useSlots });
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRoute', () => ({
		query: { state: 'nonce-1', redirect: 'owlat://auth' },
	}));
	vi.stubGlobal('useAuth', () => ({
		// Signed out: the page shows its credentials form instead of handing back.
		user: ref(null),
		isPending: ref(false),
		signInWithEmail,
		completeTwoFactorSignIn: vi.fn(),
	}));
});

afterEach(() => {
	for (const w of mounted) w.unmount();
	mounted = [];
});

function mountConnect() {
	const w = mount(ConnectPage, {
		global: {
			plugins: [createTestI18n()],
			components: { UiInput, AuthPasswordInput, AuthTwoFactorStageForm },
		},
	});
	mounted.push(w);
	return w;
}

describe('desktop/connect credentials', () => {
	it('rejects a malformed email on its field and never calls the server', async () => {
		const w = mountConnect();
		await w.get('#email').setValue('ada@');
		await w.get('#password').setValue('a-long-enough-password');
		await w.get('form').trigger('submit');
		await flushPromises();

		const email = w.get('#email');
		expect(email.attributes('aria-invalid')).toBe('true');
		expect(w.get(`#${email.attributes('aria-describedby')}`).text()).toBe(
			'Please enter a valid email address'
		);
		expect(w.get('#password').attributes('aria-invalid')).toBeUndefined();
		expect(signInWithEmail).not.toHaveBeenCalled();
	});

	it('names each missing field instead of one combined message', async () => {
		const w = mountConnect();
		await w.get('form').trigger('submit');
		await flushPromises();

		expect(w.text()).toContain('Email is required');
		expect(w.text()).toContain('Password is required');
		expect(w.findAll('[aria-invalid="true"]')).toHaveLength(2);
		expect(signInWithEmail).not.toHaveBeenCalled();
	});

	it('signs in once both fields are valid', async () => {
		const w = mountConnect();
		await w.get('#email').setValue('ada@northwind.studio');
		await w.get('#password').setValue('short');
		await w.get('form').trigger('submit');
		await flushPromises();

		expect(signInWithEmail).toHaveBeenCalledWith('ada@northwind.studio', 'short');
	});

	it('falls back to the sign-in failure copy for a non-Error rejection', async () => {
		signInWithEmail.mockRejectedValueOnce('nope');
		const w = mountConnect();
		await w.get('#email').setValue('ada@northwind.studio');
		await w.get('#password').setValue('a-long-enough-password');
		await w.get('form').trigger('submit');
		await flushPromises();

		expect(w.text()).toContain('Sign-in failed.');
	});
});
