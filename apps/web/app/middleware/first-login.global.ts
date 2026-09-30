import { api } from '@owlat/api';
import { whenConvexAuthSettled } from '~/lib/convexAuthReady';
import { TRANSIENT_RETRY_LIMIT, transientRetryDelay } from '~/lib/queryRetry';
import { readWelcomedCache, writeWelcomedCache } from '~/lib/welcomedCache';
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
 * The check NEVER blocks a navigation:
 *
 * - A "returning" answer is terminal, so it is also remembered per user id in
 *   localStorage (`~/lib/welcomedCache`, which `welcome.vue` writes too). A
 *   later session reads that and skips the query entirely.
 * - Without that entry the page renders straight away and the query runs in the
 *   background. If it says the member was never welcomed, they are redirected to
 *   `/welcome` once the navigation has settled, provided they are still on a
 *   trigger path and the welcome screen has not been reached in the meantime.
 *
 * The check only runs on the trigger paths ({@link isWelcomeTriggerPath}) so the
 * extra query stays off every other in-app navigation, and it fails OPEN: an
 * error leaves the user where they were rather than blocking the app.
 *
 * Straight after a SPA sign-in the Convex client is still installing the new
 * session's token, and `userOnboarding.get` asserts the caller. So the
 * background check first waits for Convex auth to settle, and a failed query is
 * retried a few times with backoff. Giving up after the first failure left a new
 * member on the dashboard until their next full page load.
 */

/** The background check in flight, so repeated trigger navigations share one query. */
let inflight: Promise<void> | null = null;

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
	const userId = user.value.id;

	if (readWelcomedCache(userId)) {
		resolved.value = true;
		return;
	}

	const { $convex } = useNuxtApp();
	if (!$convex) return;
	if (inflight) return;

	// Captured now: the callbacks below run outside the middleware's Nuxt context.
	const router = useRouter();
	const redirectIfStillDue = () => {
		if (resolved.value) return; // welcome.vue was reached in the meantime
		if (!isWelcomeTriggerPath(router.currentRoute.value.path)) return;
		void router.replace('/welcome');
	};
	// The answer can take a while (auth wait, retries), long enough for this
	// navigation to finish and the member to move on. Record when it settles so
	// the answer is not held back for a navigation that already happened.
	let navigationSettled = false;
	const stopSettleWatch = router.afterEach(() => {
		navigationSettled = true;
		stopSettleWatch();
	});

	const check = async () => {
		// Only a bounded wait: this runs in the background, never under the navigation.
		if (!(await whenConvexAuthSettled())) return;
		for (let attempt = 0; ; attempt++) {
			try {
				return await $convex.query(api.auth.userOnboarding.get, { userId });
			} catch (error) {
				if (attempt >= TRANSIENT_RETRY_LIMIT) throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, transientRetryDelay(attempt)));
			// welcome.vue was reached in the meantime: nothing left to decide.
			if (resolved.value) return;
		}
	};

	inflight = check()
		.then((state) => {
			if (!state) return;
			if (!shouldRouteToWelcome({ welcomedAt: state.welcomedAt })) {
				writeWelcomedCache(userId);
				resolved.value = true;
				return;
			}
			// Deliberately NOT marking resolved here: the member has not seen the
			// welcome yet, so a retry on the next trigger path is correct if the
			// redirect is interrupted. welcome.vue sets the flag.
			if (navigationSettled || router.currentRoute.value.fullPath === to.fullPath) {
				redirectIfStillDue();
				return;
			}
			// The navigation that started the check is still running (later guards,
			// async page chunks): decide once it has settled.
			const stop = router.afterEach(() => {
				stop();
				redirectIfStillDue();
			});
		})
		.catch(() => {
			// Fail open — the welcome nudge must never wedge the app. Leave the flag
			// unset so the next trigger navigation gets another chance.
		})
		.finally(() => {
			stopSettleWatch();
			inflight = null;
		});
});
