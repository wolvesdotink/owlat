/**
 * Global route-level feature gate.
 *
 * A path whose feature is switched off redirects to `/dashboard?disabled=<flag>`,
 * where the Workbench says which feature is off (`useFeatureOffNotice`). Which
 * flags a path needs comes from `lib/routeFeatureGates.ts`, the same table the
 * command palette, the getting-started checklist and the other link surfaces
 * read, so none of them offers a page this guard would bounce.
 */

import { blockedFeature, routeFeatureRule } from '~/lib/routeFeatureGates';

export default defineNuxtRouteMiddleware((to) => {
	// An ungated path never opens the flag subscription.
	if (!routeFeatureRule(to.path)) return;

	// Don't bounce if we're already on the dashboard root — avoids redirect loops.
	if (to.path === '/dashboard') return;

	const { isEnabled, isLoading } = useFeatureFlag();

	// Flags load asynchronously via a Convex subscription. On a hard reload /
	// direct deep-link the subscription hasn't delivered yet, so isEnabled()
	// falls back to defaults — and many features default OFF (automations, inbox,
	// chat, postbox, ai.*). Bouncing here would redirect users AWAY from features
	// they actually have enabled. Only gate once flags are confirmed loaded; the
	// nav already hides disabled links and feature data is empty when off, so a
	// page rendering briefly during load is harmless: a flag is product gating,
	// not an access-control boundary, and the gated function families (chat, the
	// assistant, Postbox, AI dashboards) re-check their own flag server-side, so
	// an early render cannot act on a feature this instance has switched off.
	if (isLoading.value) return;

	const blocked = blockedFeature(to.path, isEnabled);
	if (blocked) {
		return navigateTo({ path: '/dashboard', query: { disabled: blocked } }, { replace: true });
	}
});
