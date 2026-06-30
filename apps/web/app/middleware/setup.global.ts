/**
 * Global setup-mode middleware.
 *
 * While `OWLAT_SETUP_MODE=true` (set by the install/setup CLI and surfaced as the
 * `setupMode` public runtime-config flag) every route redirects to `/setup`, so a
 * fresh instance always lands on the wizard. This keys purely off the runtime
 * flag — it does NOT inspect whether an admin user exists.
 *
 * The flag lives in the web process env, so it only flips off when the web
 * container restarts with the freshly-written `.env`. Until that restart lands,
 * an operator who just completed the wizard would otherwise be bounced back to
 * `/setup` on every navigation. To avoid that trap, `/auth/*` is allowlisted:
 * before an admin exists it is a harmless dead end, and once `apply` creates the
 * admin it is the intended sign-in destination — so the review step can forward
 * the operator straight to login without waiting for the restart.
 */

/**
 * Path prefixes reachable while setup mode is still live: the wizard itself, its
 * API, the auth/sign-in routes, and the static assets the wizard needs.
 */
export const SETUP_ALLOWLIST_PREFIXES = [
	'/setup',
	'/api/setup',
	'/auth',
	'/_nuxt',
	'/favicon',
] as const;

/** True when `path` may be visited without being redirected to the wizard. */
export function isSetupAllowlisted(path: string): boolean {
	return SETUP_ALLOWLIST_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export default defineNuxtRouteMiddleware((to) => {
	if (import.meta.server) return;

	const config = useRuntimeConfig();
	const setupMode = Boolean(config.public.setupMode);
	if (!setupMode) return;

	if (isSetupAllowlisted(to.path)) return;

	return navigateTo('/setup', { replace: true });
});
