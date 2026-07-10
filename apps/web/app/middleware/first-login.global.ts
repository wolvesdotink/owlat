import { api } from '@owlat/api';
import { isWelcomeTriggerPath, shouldRouteToWelcome } from '~/utils/welcomeFlow';

/**
 * Global first-login middleware.
 *
 * A brand-new member who has never seen the welcome screen is routed to
 * `/welcome` the first time they land on the app's home surfaces (the dashboard
 * or the Postbox). Returning users — anyone whose `userOnboarding` row already
 * carries a `welcomedAt` stamp — are NEVER bounced there again.
 *
 * The first-login answer can only ever flip from "new" to "returning" (never
 * back), so it is resolved AT MOST ONCE per session: a session-scoped
 * `first-login-resolved` flag short-circuits the check on every later
 * navigation. That keeps the Convex round-trip off the Postbox hot path —
 * folder switches and message opens (`/dashboard/postbox/**`) never pay for it
 * after the first resolution. `welcome.vue` sets the same flag synchronously on
 * mount, closing the bounce race where a member exits `/welcome` (onto a trigger
 * path) before the fire-and-forget `markWelcomed` mutation has committed.
 *
 * The check only runs on the trigger paths ({@link isWelcomeTriggerPath}) so the
 * extra query stays off every other in-app navigation, and it fails OPEN: any
 * error leaves the user where they were rather than blocking the app.
 */
export default defineNuxtRouteMiddleware(async (to) => {
	if (import.meta.server) return;
	if (!isWelcomeTriggerPath(to.path)) return;

	// Resolve once per session — either outcome is terminal (welcomedAt never
	// unsets), so a later navigation must not re-query.
	const resolved = useState('first-login-resolved', () => false);
	if (resolved.value) return;

	const { isAuthenticated, user, waitUntilReady } = useAuth();
	await waitUntilReady();
	if (!isAuthenticated.value || !user.value?.id) return;

	const { $convex } = useNuxtApp();
	if (!$convex) return;

	try {
		const state = await $convex.query(api.auth.userOnboarding.get, { userId: user.value.id });
		if (shouldRouteToWelcome({ welcomedAt: state.welcomedAt })) {
			// Deliberately NOT marking resolved here: the member has not seen the
			// welcome yet, so a retry on the next trigger path is correct if the
			// navigation to /welcome is interrupted. welcome.vue sets the flag.
			return navigateTo('/welcome', { replace: true });
		}
		resolved.value = true;
	} catch {
		// Fail open — the welcome nudge must never wedge the app. Leave the flag
		// unset so a transient error gets one more chance on the next navigation.
	}
});
