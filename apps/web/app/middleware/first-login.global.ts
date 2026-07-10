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
 * The check only runs on the trigger paths ({@link isWelcomeTriggerPath}) so the
 * extra Convex query stays off every in-app navigation, and it fails OPEN: any
 * error leaves the user where they were rather than blocking the app.
 */
export default defineNuxtRouteMiddleware(async (to) => {
	if (import.meta.server) return;
	if (!isWelcomeTriggerPath(to.path)) return;

	const { isAuthenticated, user, waitUntilReady } = useAuth();
	await waitUntilReady();
	if (!isAuthenticated.value || !user.value?.id) return;

	const { $convex } = useNuxtApp();
	if (!$convex) return;

	try {
		const state = await $convex.query(api.auth.userOnboarding.get, { userId: user.value.id });
		if (shouldRouteToWelcome({ welcomedAt: state.welcomedAt })) {
			return navigateTo('/welcome', { replace: true });
		}
	} catch {
		// Fail open — the welcome nudge must never wedge the app.
	}
});
