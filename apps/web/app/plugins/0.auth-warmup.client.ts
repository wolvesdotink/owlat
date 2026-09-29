/**
 * Auth warm-up: start the better-auth session fetch and the Convex token fetch
 * as the very first thing the app does, so both round trips overlap the i18n
 * catalog load instead of queueing behind it.
 *
 * Without this, the session store is created by the first `useAuth()` call in
 * route middleware and the token fetch starts in `convex.client.ts`; both run
 * only after the (blocking) i18n plugin has loaded its messages. `parallel: true`
 * keeps this plugin from holding up the ones after it, and it awaits nothing.
 *
 * Neither fetch is duplicated: `useAuth` reuses the one session store built
 * here, and `getConvexAuthToken` hands the Convex client the request already in
 * flight. The token lives in memory only and is never persisted.
 *
 * Skipped where `convex.client.ts` skips auth (public pages; the token alone
 * when no Convex URL is configured), in setup mode (a fresh instance with no admin to sign in as), and on the
 * desktop runtime, where the token request needs the keychain session that the
 * desktop boot plugin loads first and the catalog is a local file anyway.
 */
import { warmAuthSession } from '~/composables/useAuth';
import { warmConvexAuthToken } from '~/lib/convex-auth';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { isPublicRoute } from '~/utils/publicRoutes';

export default defineNuxtPlugin({
	name: 'owlat:auth-warmup',
	enforce: 'pre',
	parallel: true,
	setup() {
		if (isDesktopRuntime()) return;
		const config = useRuntimeConfig();
		if (config.public.setupMode || isPublicRoute()) return;

		warmAuthSession();
		if (config.public.convexUrl) warmConvexAuthToken();
	},
});
