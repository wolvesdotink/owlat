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
		const authCallback = async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
			return getConvexAuthToken(forceRefreshToken);
		};
		client.setAuth(authCallback);

		if (!authListenerRegistered) {
			authListenerRegistered = true;
			authClient.$store.listen('$sessionSignal', () => {
				resetConvexAuthTokenCache();
				client.setAuth(authCallback);
			});
		}
	}

	return {
		provide: {
			convex: client as ConvexClient | null,
		},
	};
});
