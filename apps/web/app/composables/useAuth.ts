import type { BetterFetchError } from '@better-fetch/fetch';
import { effectScope, type EffectScope } from 'vue';
import { authClient, type AuthSessionData } from '~/lib/auth-client';
import { resetConvexAuthTokenCache } from '~/lib/convex-auth';
import { requiresTwoFactor } from '~/utils/accountTwoFactor';

type SessionData = AuthSessionData | null;

export type AuthStatus = 'pending' | 'authenticated' | 'unauthenticated' | 'error';

type RefreshSessionOptions = {
	force?: boolean;
	expected?: 'authenticated' | 'unauthenticated';
	activeOrganizationId?: string | null;
	maxRetries?: number;
	intervalMs?: number;
};

const READY_TIMEOUT_MS = 5_000;
const SYNC_RETRY_INTERVAL_MS = 75;
const SYNC_MAX_RETRIES = 10;

const freshSessionOptions = {
	query: {
		disableCookieCache: true,
	},
} satisfies NonNullable<Parameters<typeof authClient.getSession>[0]>;

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The message catalog, resolved where one exists.
 *
 * `useAuth` is called from route middleware as well as from page setups, and
 * `useI18n()` throws outside a component instance. Middleware only reads
 * session state — it never reaches a branch that produces copy — so outside a
 * component the fallbacks degrade to their key rather than taking the app down.
 */
function authTranslator(): (key: string) => string {
	if (!getCurrentInstance()) return (key: string) => key;
	const { t } = useI18n();
	return (key: string) => t(key);
}

function toError(error: BetterFetchError | null, t: (key: string) => string): Error | null {
	if (!error) {
		return null;
	}

	return new Error(error.message || t('shared.useAuth.requestFailed'));
}

function matchesExpectedSession(session: SessionData, options: RefreshSessionOptions): boolean {
	if (options.expected === 'authenticated' && !session) {
		return false;
	}

	if (options.expected === 'unauthenticated' && session) {
		return false;
	}

	if (
		options.activeOrganizationId !== undefined &&
		(session?.session.activeOrganizationId ?? null) !== options.activeOrganizationId
	) {
		return false;
	}

	return true;
}

/**
 * The better-auth session store, subscribed ONCE for the app's lifetime.
 *
 * `authClient.useSession()` opens a nanostore subscription and only releases it
 * through `onScopeDispose` — i.e. only when an effect scope is active. `useAuth`
 * is called from route middleware, where after the first `await` there is none,
 * so every navigation to a guarded route added a listener that was never
 * released. The session is a single piece of global state, so one subscriber is
 * the right shape anyway; a DETACHED scope owns it so no caller's teardown can
 * cut everyone else off. Mirrors `useFeatureFlag`.
 */
// Wrapped rather than `ReturnType<typeof authClient.useSession>`: better-auth
// declares that hook with a server (Promise) and a client (Ref) result, and only
// a real call expression picks the right one.
function createSessionStore() {
	return authClient.useSession();
}

type SessionStore = ReturnType<typeof createSessionStore>;

let sessionScope: EffectScope | null = null;

let sharedSession: SessionStore | null = null;

function sessionStore(): SessionStore {
	if (!sharedSession) {
		sessionScope = effectScope(true);
		sessionScope.run(() => {
			sharedSession = createSessionStore();
		});
		// `run` is a no-op on a stopped scope, and a fresh detached one is never
		// stopped — but say so rather than asserting a null away.
		if (!sharedSession) {
			throw new Error('useAuth: could not build the better-auth session store');
		}
	}
	return sharedSession;
}

export function useAuth() {
	const t = authTranslator();
	const sessionState = sessionStore();

	const sessionData = computed<SessionData>(() => sessionState.value.data ?? null);

	const status = computed<AuthStatus>(() => {
		if (sessionState.value.isPending) {
			return 'pending';
		}

		if (sessionState.value.data) {
			return 'authenticated';
		}

		if (sessionState.value.error) {
			return 'error';
		}

		return 'unauthenticated';
	});

	const isPending = computed(() => status.value === 'pending');
	const error = computed(() => toError(sessionState.value.error, t));

	const isAuthenticated = computed(() => {
		return status.value === 'authenticated';
	});

	const user = computed(() => {
		return sessionData.value?.user ?? null;
	});

	const currentSession = computed(() => {
		return sessionData.value?.session ?? null;
	});

	const activeOrganizationId = computed(() => {
		return currentSession.value?.activeOrganizationId ?? null;
	});

	const hasActiveOrganization = computed(() => {
		return !!activeOrganizationId.value;
	});

	const waitUntilReady = async (timeoutMs = READY_TIMEOUT_MS) => {
		await waitForLoaded(status, (s) => s !== 'pending', timeoutMs);

		return status.value;
	};

	const refetch = async (options: RefreshSessionOptions = {}) => {
		const maxRetries = options.force ? (options.maxRetries ?? SYNC_MAX_RETRIES) : 1;
		const intervalMs = options.intervalMs ?? SYNC_RETRY_INTERVAL_MS;

		if (options.force) {
			resetConvexAuthTokenCache();
		}

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			const result = options.force
				? await authClient.getSession(freshSessionOptions)
				: await authClient.getSession();

			const resolvedSession = result.data ?? null;
			if (matchesExpectedSession(resolvedSession, options)) {
				authClient.$store.notify('$sessionSignal');
				return resolvedSession;
			}

			if (attempt < maxRetries - 1) {
				await delay(intervalMs);
			}
		}

		authClient.$store.notify('$sessionSignal');
		return sessionData.value;
	};

	const signInWithEmail = async (email: string, password: string) => {
		const result = await authClient.signIn.email({
			email,
			password,
		});

		if (result.error) {
			throw new Error(result.error.message || t('shared.useAuth.signInFailed'));
		}

		// An account with TOTP enabled answers with `{ twoFactorRedirect: true }`
		// and NO session. Syncing here would burn the full retry budget waiting
		// for a session the server is deliberately withholding, and then return
		// as if sign-in had succeeded — the caller must run the challenge and
		// come back through `completeTwoFactorSignIn`.
		if (requiresTwoFactor(result.data)) {
			return result.data;
		}

		await refetch({ force: true, expected: 'authenticated' });

		return result.data;
	};

	/**
	 * Second leg of a two-factor sign-in: redeem the challenge, then run the same
	 * forced session sync the password leg runs, so a caller cannot navigate
	 * before the Convex token cache has been reset against the new session.
	 *
	 * `method` picks the factor. A backup code is a one-shot fallback for a lost
	 * authenticator, so it is a different endpoint, not a different code format.
	 */
	const completeTwoFactorSignIn = async (input: {
		code: string;
		method?: 'totp' | 'backup-code';
	}) => {
		const result =
			input.method === 'backup-code'
				? await authClient.twoFactor.verifyBackupCode({ code: input.code })
				: await authClient.twoFactor.verifyTotp({ code: input.code });

		if (result.error) {
			// Unlike the sibling calls above, the server's own message is NOT used:
			// every failure here is "that code was not accepted" (wrong code, spent
			// backup code, expired challenge), and BetterAuth phrases those as
			// untranslated English prose that would land straight on the sign-in
			// form. One catalog message says the same thing in the user's language.
			throw new Error(t('shared.useAuth.twoFactorFailed'));
		}

		await refetch({ force: true, expected: 'authenticated' });

		return result.data;
	};

	const signUpWithEmail = async (email: string, password: string, name: string) => {
		const result = await authClient.signUp.email({
			email,
			password,
			name,
		});

		if (result.error) {
			throw new Error(result.error.message || t('shared.useAuth.signUpFailed'));
		}

		await refetch({ force: true, expected: 'authenticated' });

		return result.data;
	};

	/**
	 * Wait for the session STORE to show signed-out, not just the request.
	 *
	 * `refetch` resolves on its own direct `getSession` and then notifies the
	 * store, which refetches asynchronously — and BetterAuth's atom sets
	 * `isPending: current.data === null`, so while a signed-in session is being
	 * refetched the store still reports "not pending, signed in". Navigating on
	 * that stale answer starts a fight: `guest` sees a session on /auth/login and
	 * sends the user back to /dashboard, `auth` has meanwhile seen the truth and
	 * sends them forward again, and vue-router aborts the ping-pong — leaving the
	 * browser on the page it started from, signed out, with no error anywhere.
	 */
	const waitUntilSignedOut = async (timeoutMs = READY_TIMEOUT_MS) => {
		if (sessionData.value === null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(finish, timeoutMs);
			const stop = watch(sessionData, (value) => {
				if (value === null) finish();
			});
			function finish() {
				clearTimeout(timer);
				stop();
				resolve();
			}
		});
	};

	const signOut = async () => {
		const result = await authClient.signOut();

		if (result.error) {
			throw new Error(result.error.message || t('shared.useAuth.signOutFailed'));
		}

		await refetch({ force: true, expected: 'unauthenticated' });
		await waitUntilSignedOut();

		await navigateTo('/auth/login');

		return result.data;
	};

	const forgotPassword = async (email: string) => {
		const result = await authClient.requestPasswordReset({
			email,
			redirectTo: '/auth/reset-password',
		});

		if (result.error) {
			throw new Error(result.error.message || t('shared.useAuth.resetEmailFailed'));
		}

		return result.data;
	};

	const resetPassword = async (newPassword: string, token: string) => {
		const result = await authClient.resetPassword({
			newPassword,
			token,
		});

		if (result.error) {
			throw new Error(result.error.message || t('shared.useAuth.resetPasswordFailed'));
		}

		return result.data;
	};

	return {
		sessionData,
		user,
		currentSession,
		status,
		isAuthenticated,
		isPending,
		error,
		activeOrganizationId,
		hasActiveOrganization,
		signInWithEmail,
		completeTwoFactorSignIn,
		signUpWithEmail,
		signOut,
		forgotPassword,
		resetPassword,
		refetch,
		waitUntilReady,
	};
}

// Detached scopes outlive their callers and must be stopped on hot replacement.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		sessionScope?.stop();
		sessionScope = null;
		sharedSession = null;
	});
}
