import type { BetterFetchError } from '@better-fetch/fetch';
import { authClient, type AuthSessionData } from '~/lib/auth-client';
import { resetConvexAuthTokenCache } from '~/lib/convex-auth';

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

function toError(error: BetterFetchError | null): Error | null {
	if (!error) {
		return null;
	}

	return new Error(error.message || 'Authentication request failed');
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

export function useAuth() {
	const sessionState = authClient.useSession();

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
	const error = computed(() => toError(sessionState.value.error));

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
		await waitForLoaded(
			status,
			(s) => s !== 'pending',
			timeoutMs,
		);

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
			throw new Error(result.error.message || 'Sign in failed');
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
			throw new Error(result.error.message || 'Sign up failed');
		}

		await refetch({ force: true, expected: 'authenticated' });

		return result.data;
	};

	const signOut = async () => {
		const result = await authClient.signOut();

		if (result.error) {
			throw new Error(result.error.message || 'Sign out failed');
		}

		await refetch({ force: true, expected: 'unauthenticated' });

		await navigateTo('/auth/login');

		return result.data;
	};

	const forgotPassword = async (email: string) => {
		const result = await authClient.requestPasswordReset({
			email,
			redirectTo: '/auth/reset-password',
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to send reset email');
		}

		return result.data;
	};

	const resetPassword = async (newPassword: string, token: string) => {
		const result = await authClient.resetPassword({
			newPassword,
			token,
		});

		if (result.error) {
			throw new Error(result.error.message || 'Failed to reset password');
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
		signUpWithEmail,
		signOut,
		forgotPassword,
		resetPassword,
		refetch,
		waitUntilReady,
	};
}
