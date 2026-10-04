import { ConvexClient } from 'convex/browser';
import { authClient } from '~/lib/auth-client';
import {
	getConvexAuthToken,
	lastConvexTokenFailure,
	resetConvexAuthTokenCache,
} from '~/lib/convex-auth';
import { markConvexAuthPending, reportConvexAuth } from '~/lib/convexAuthReady';
import { createConvexAuthRecovery, type ConvexAuthFailure } from '~/lib/convexAuthRecovery';
import { useToast } from '@owlat/ui/composables/useToast';
import { isDesktopRuntime, getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { logWarn } from '~/lib/runtimeLog';
import { clearCachedFeatureFlags } from '~/lib/featureFlagCache';
import { resetSharedConvexSubscriptions } from '~/lib/sharedConvexSubscriptions';
import { isPublicPath } from '~/utils/publicRoutes';

let authListenerRegistered = false;

/**
 * What `useAuth().signOut` forgets on this device, for a session that ended
 * without one: the last-known feature flags and the Postbox rows and bodies
 * cached for offline reading. Loaded on demand so the IndexedDB store stays out
 * of the boot bundle.
 */
async function forgetSignedOutDevice(): Promise<void> {
	clearCachedFeatureFlags();
	try {
		const { wipePostboxOfflineReadCache } =
			await import('~/composables/postbox/usePostboxOfflineCache');
		await wipePostboxOfflineReadCache();
	} catch {
		// The chunk failed to load: the redirect to sign-in must still happen.
	}
}

export default defineNuxtPlugin((nuxtApp) => {
	const config = useRuntimeConfig();
	// Desktop builds bake no Convex URL — it comes from the active workspace,
	// seeded by the boot plugin (0.desktop-workspace.client.ts) that runs before
	// this one. With no active workspace the client stays null and the pre-auth
	// gate routes to /desktop/welcome.
	const convexUrl = isDesktopRuntime()
		? (getActiveWorkspace()?.convexUrl ?? '')
		: (config.public.convexUrl as string);

	if (!convexUrl) {
		if (!isDesktopRuntime()) {
			logWarn('NUXT_PUBLIC_CONVEX_URL is not set. Convex client not initialized.');
		}
		return {
			provide: {
				convex: null as ConvexClient | null,
			},
		};
	}

	const client = new ConvexClient(convexUrl);
	const router = useRouter();

	/**
	 * Install the token fetcher and the session listener on this client. Runs
	 * once per client: at boot on an app route, or on the first navigation from
	 * a public page into the app (see below).
	 */
	let authActivated = false;
	const activateAuth = () => {
		if (authActivated) return;
		authActivated = true;
		const authCallback = async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
			return getConvexAuthToken(forceRefreshToken);
		};

		const installAuth = () => {
			markConvexAuthPending();
			client.setAuth(authCallback, onAuthChange);
		};

		// After a definitive failure the Convex client drops its auth config, and
		// nothing fetches a token again until `setAuth` runs anew. While the
		// session may still be fine, re-install it with a bounded backoff
		// (lib/convexAuthRecovery.ts); when every attempt fails, say so on screen.
		let lostToastId: string | null = null;
		const recovery = createConvexAuthRecovery({
			reinstall: () => {
				resetConvexAuthTokenCache();
				installAuth();
			},
			onGiveUp: (failure: ConvexAuthFailure) => {
				logWarn(
					failure === 'rejected'
						? 'Convex auth failed while the session is still valid — check auth config.'
						: 'Convex auth failed: the token endpoint could not be reached.'
				);
				const t = (key: string) => (nuxtApp.$i18n as { t: (key: string) => string }).t(key);
				const { showToast } = useToast();
				lostToastId = showToast(t('shared.convexAuth.lost'), 'error', {
					durationMs: 0,
					action: { label: t('shared.convexAuth.reload'), onAction: () => location.reload() },
					onDismiss: () => {
						lostToastId = null;
					},
				});
			},
			onRecovered: () => {
				if (lostToastId) useToast().removeToast(lostToastId);
			},
		});
		window.addEventListener('online', () => recovery.resume());

		// Definitive auth-loss handler (`setAuth`'s onChange). The Convex client
		// calls it with `false` when it gives up authenticating — the token fetch
		// returned null or the server rejected the JWT. Without it, subscriptions
		// opened while the client-side session state still said "authenticated"
		// keep re-running unauthenticated: every gated query throws
		// "Not authenticated" server-side and the UI just sits on dead spinners.
		// Typical trigger: a (dev) backend reset that orphans the stored session.
		let recovering = false;
		let staleSessionNotifies = 0;
		const handleAuthLoss = async () => {
			if (recovering) return;
			recovering = true;
			try {
				// The token request got no answer (offline, timeout, 5xx): that says
				// nothing about the session, so try again without asking for it.
				if (lastConvexTokenFailure() === 'unreachable') {
					recovery.retry('unreachable');
					return;
				}
				const { data, error } = await authClient.getSession({
					query: { disableCookieCache: true },
				});
				if (data) {
					// The session is alive yet no token was accepted: a flaky server, or
					// an auth config problem (issuer/JWKS mismatch) that the retries run
					// into until they give up. Flipping session state would sign the user
					// out for nothing.
					recovery.retry('rejected');
					return;
				}
				// The session check itself failed (offline): the session may be fine
				// and the offline cache is the point. Try again later.
				if (error && error.status !== 401 && error.status !== 403) {
					recovery.retry('unreachable');
					return;
				}
				recovery.reset();
				// The server says there is no session: it expired or was revoked, and
				// nobody signed out. Forget what sign-out forgets, or the cached mail of
				// the person who was here stays on this device.
				await forgetSignedOutDevice();

				// The stored session is dead. Flip the client-side session state so
				// gated queries unsubscribe and the app reflects signed-out. Only
				// notify while the store still says authenticated (the signal
				// re-runs setAuth, which fails again and lands back here) — the
				// counter is a hard bound in case the atom shape ever changes.
				resetConvexAuthTokenCache();
				const sessionAtom = (
					authClient.$store as unknown as {
						atoms?: Record<string, { get?: () => { data?: unknown } | undefined }>;
					}
				).atoms?.['session'];
				const sessionValue = sessionAtom?.get?.();
				const storeThinksAuthed = sessionValue ? !!sessionValue.data : true;
				// A plain signed-out visitor (store already says unauthenticated) needs
				// neither the flip nor a redirect — route middleware owns that case.
				if (!storeThinksAuthed) return;

				if (staleSessionNotifies < 3) {
					staleSessionNotifies++;
					authClient.$store.notify('$sessionSignal');
				}

				// Route to re-login unless already parked on an auth/desktop screen.
				const path = router.currentRoute.value.path;
				const parked =
					path.startsWith('/auth') || path.startsWith('/desktop/') || path.startsWith('/setup');
				if (!parked) {
					await navigateTo(
						isDesktopRuntime() && !import.meta.dev ? '/desktop/welcome' : '/auth/login'
					);
				}
			} finally {
				recovering = false;
			}
		};
		const onAuthChange = (isAuthenticated: boolean) => {
			reportConvexAuth(isAuthenticated);
			if (isAuthenticated) {
				staleSessionNotifies = 0;
				recovery.reset();
				return;
			}
			resetSharedConvexSubscriptions();
			void handleAuthLoss();
		};
		installAuth();

		if (!authListenerRegistered) {
			authListenerRegistered = true;
			// Fires on sign-in, sign-out and an organization switch. Queries kept
			// warm for the previous identity must not render for the next one.
			authClient.$store.listen('$sessionSignal', () => {
				resetSharedConvexSubscriptions();
				resetConvexAuthTokenCache();
				// A new identity gets a fresh retry budget and no stale reinstall.
				recovery.reset();
				installAuth();
			});
		}
	};

	// On public pages (share, archive, etc.), skip auth — these pages use direct
	// fetch() to Convex HTTP endpoints, not the Convex client, and a visitor who
	// only opens one must not cause /api/auth/convex/token or session requests.
	// Auth is installed instead the first time a navigation leaves the public
	// pages (a link from /terms into the app, the sign-in page), ahead of the
	// named route middleware that may query Convex. Plugins run once, so a
	// check made only here would leave that client anonymous until a reload.
	if (!isPublicRoute()) {
		activateAuth();
	} else {
		addRouteMiddleware(
			'convex-auth-activation',
			(to) => {
				if (!isPublicPath(to.path)) activateAuth();
			},
			{ global: true }
		);
	}

	return {
		provide: {
			convex: client as ConvexClient | null,
		},
	};
});
