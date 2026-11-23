import { afterEach, describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import de from '~~/i18n/locales/de.json';
import { useAuthForm } from '../useAuthForm';
import { useAuth } from '../useAuth';
import { createTestI18n } from '~/__tests__/i18n';
import { withSetup } from '~/__tests__/withSetup';

/**
 * The composable resolves its copy through vue-i18n; install the real catalog
 * behind the `useI18n` auto-import so the assertions read as the app ships.
 */
const i18n = createTestI18n();
i18n.global.setLocaleMessage('de', de);
vi.stubGlobal('useI18n', () => i18n.global);

/** What better-auth answers a wrong password with: its own English sentence and a code. */
const signInEmail = vi.fn(async () => ({
	data: null,
	error: {
		code: 'INVALID_EMAIL_OR_PASSWORD',
		message: 'Invalid email or password',
		status: 401,
		statusText: 'UNAUTHORIZED',
	},
}));

vi.mock('~/lib/auth-client', () => ({
	authClient: {
		useSession: () => ref({ data: null, isPending: false, error: null }),
		signIn: { email: () => signInEmail() },
		getSession: vi.fn(async () => ({ data: null })),
		$store: { notify: vi.fn() },
	},
}));
vi.mock('~/lib/convex-auth', () => ({ resetConvexAuthTokenCache: vi.fn() }));

afterEach(() => {
	i18n.global.locale.value = 'en';
});

describe('useAuthForm', () => {
	it('starts not loading with no error', () => {
		const { isLoading, errorMessage } = useAuthForm();
		expect(isLoading.value).toBe(false);
		expect(errorMessage.value).toBe('');
	});

	it('flips loading during the action and clears it after', async () => {
		const { isLoading, submit } = useAuthForm();
		let loadingDuring = false;

		await submit(async () => {
			loadingDuring = isLoading.value;
		});

		expect(loadingDuring).toBe(true);
		expect(isLoading.value).toBe(false);
	});

	it('clears a previous error before running', async () => {
		const { errorMessage, submit } = useAuthForm();
		await submit(async () => {
			throw new Error('first');
		});
		expect(errorMessage.value).toBe('first');

		await submit(async () => {
			/* succeeds */
		});
		expect(errorMessage.value).toBe('');
	});

	it('surfaces a thrown Error message', async () => {
		const { errorMessage, submit } = useAuthForm();
		await submit(async () => {
			throw new Error('Invalid credentials');
		});
		expect(errorMessage.value).toBe('Invalid credentials');
	});

	it('uses the fallback message for non-Error throws', async () => {
		const { errorMessage, submit } = useAuthForm();
		await submit(async () => {
			throw 'nope';
		}, 'Custom fallback');
		expect(errorMessage.value).toBe('Custom fallback');
	});

	it('always clears loading even when the action throws', async () => {
		const { isLoading, submit } = useAuthForm();
		await submit(async () => {
			throw new Error('boom');
		});
		expect(isLoading.value).toBe(false);
	});

	it('does not set an error on success', async () => {
		const { errorMessage, submit } = useAuthForm();
		const action = vi.fn(async () => {});
		await submit(action);
		expect(action).toHaveBeenCalledTimes(1);
		expect(errorMessage.value).toBe('');
	});

	it('shows a wrong password as a sentence in the reader’s language, not better-auth’s', async () => {
		i18n.global.locale.value = 'de';
		const { errorMessage, submit, signInWithEmail } = withSetup(() => ({
			...useAuthForm(),
			...useAuth(),
		})).result;

		await submit(async () => {
			await signInWithEmail('ada@owlat.example', 'not-the-password');
		});

		expect(signInEmail).toHaveBeenCalledTimes(1);
		expect(errorMessage.value).toBe('E-Mail-Adresse oder Passwort stimmt nicht.');
		expect(errorMessage.value).not.toContain('Invalid email or password');
	});
});
