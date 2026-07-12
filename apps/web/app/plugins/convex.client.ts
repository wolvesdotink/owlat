import { ConvexClient } from 'convex/browser';
import { authClient } from '~/lib/auth-client';
import { getConvexAuthToken, resetConvexAuthTokenCache } from '~/lib/convex-auth';
import { isDesktopRuntime, getActiveWorkspace } from '~/lib/desktop/activeWorkspace';
import { logWarn } from '~/lib/runtimeLog';

let authListenerRegistered = false;

export default defineNuxtPlugin(() => {
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

	// On public pages (share, archive, etc.), skip auth entirely — these pages
	// use direct fetch() to Convex HTTP endpoints, not the Convex client.
	// This avoids unnecessary /api/auth/convex/token requests for unauthenticated visitors.
	if (!isPublicRoute()) {
		const router = useRouter();
		const authCallback = async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
			return getConvexAuthToken(forceRefreshToken);
		};

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
				const { data } = await authClient.getSession({
					query: { disableCookieCache: true },
				});
				if (data) {
					// The session is genuinely alive yet Convex rejected it — an auth
					// config problem (issuer/JWKS mismatch), not a stale session.
					// Flipping session state would sign the user out for nothing.
					logWarn('Convex auth failed while the session is still valid — check auth config.');
					return;
				}

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
			if (isAuthenticated) {
				staleSessionNotifies = 0;
				return;
			}
			void handleAuthLoss();
		};
		client.setAuth(authCallback, onAuthChange);

		if (!authListenerRegistered) {
			authListenerRegistered = true;
			authClient.$store.listen('$sessionSignal', () => {
				resetConvexAuthTokenCache();
				client.setAuth(authCallback, onAuthChange);
			});
		}
	}

	return {
		provide: {
			convex: client as ConvexClient | null,
		},
	};
});
