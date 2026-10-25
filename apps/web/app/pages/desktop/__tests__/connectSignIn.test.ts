/**
 * The desktop connect handshake validates its credentials like the sign-in
 * page: per field, with the same messages. It used to accept any non-empty
 * email and answer an empty field with one combined sentence, so a typo in the
 * address went to the server as a sign-in attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref, useSlots } from 'vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
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
			components: { UiButton, UiInput, AuthPasswordInput, AuthTwoFactorStageForm },
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

describe('desktop/connect hand-back', () => {
	it.each([
		['an object token', '{"token":{"value":"ott_1"}}'],
		['a number token', '{"token":42}'],
		['a body that is not JSON', '<html>proxy</html>'],
		['no token', '{}'],
	])('hands nothing back for a token answer with %s', async (_case, body) => {
		signedIn();
		const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const before = window.location.href;

		const w = mountConnect();
		await flushPromises();

		expect(fetchMock).toHaveBeenCalledWith('/api/auth/one-time-token/generate', {
			credentials: 'include',
		});
		expect(w.text()).not.toContain('nonce-1:');
		expect(w.text()).not.toContain('[object Object]');
		expect(window.location.href).toBe(before);
		// The hand-back stopped: the page says so instead of "Signing you in…".
		expect(w.get('[role="alert"]').text()).toMatch(
			/^(Could not create a sign-in token\.|No token returned by the server\.)$/
		);
		expect(w.text()).not.toContain('Signing you in');
	});

	it('says why a failed token request stopped and asks again on retry', async () => {
		signedIn();
		const fetchMock = vi.fn(async () => new Response('{"token":42}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const w = mountConnect();
		await flushPromises();
		expect(w.get('[role="alert"]').text()).toBe('Could not create a sign-in token.');

		// The retry asks for a new token; this one fails at the server.
		fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
		const retry = w.findAll('button').find((b) => b.text() === 'Try again');
		expect(retry).toBeDefined();
		await retry!.trigger('click');
		await flushPromises();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(w.get('[role="alert"]').text()).toBe('Could not create a sign-in token.');
		expect(w.text()).not.toContain('Signing you in');

		// A usable token on the next retry is handed back as usual.
		fetchMock.mockResolvedValueOnce(new Response('{"token":"ott_1"}', { status: 200 }));
		await w
			.findAll('button')
			.find((b) => b.text() === 'Try again')!
			.trigger('click');
		await flushPromises();

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(w.find('[role="alert"]').exists()).toBe(false);
		expect(w.text()).toContain('Signing you in');
		expect(w.text()).toContain('nonce-1:ott_1');
	});
});

function signedIn() {
	vi.stubGlobal('useAuth', () => ({
		user: ref({ id: 'user-1' }),
		isPending: ref(false),
		signInWithEmail,
		completeTwoFactorSignIn: vi.fn(),
	}));
}
