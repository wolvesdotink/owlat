/**
 * Global route-level feature gate.
 *
 * Pages declare `definePageMeta({ requiresFeature: '<FeatureFlagKey>' })` and
 * this middleware redirects to `/dashboard?disabled=<flag>` when the flag is
 * off. The dashboard layout's nav already hides links to disabled features —
 * this middleware closes the deep-link / direct-navigation hole.
 *
 * Why not in `definePageMeta(middleware:)` per-page? Page-scoped middleware
 * has to be referenced by name, which means each page reimplements the redirect.
 * A global middleware reading `to.meta.requiresFeature` keeps every page
 * declarative — one line in `definePageMeta`.
 */

import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

declare module '#app' {
	interface PageMeta {
		/**
		 * Feature flag (or array of flags — all must be enabled) required to
		 * view this route. When disabled, the user is redirected to /dashboard.
		 */
		requiresFeature?: FeatureFlagKey | FeatureFlagKey[];
		/**
		 * OR-group: at least one of these flags must be enabled. Evaluated
		 * after `requiresFeature` (which is AND). Used where one surface is
		 * reachable via multiple features — e.g. the Postbox UI under hosted
		 * `postbox` OR `mail.external`.
		 */
		requiresAnyFeature?: FeatureFlagKey[];
		/**
		 * Opt a route OUT of the path-derived feature gate below. Set on the
		 * rare page under a gated path prefix that must stay reachable even when
		 * the feature is off (none today — present for completeness).
		 */
		publicFeature?: boolean;
	}
}

/**
 * Path-derived feature gate — the single source of truth so route gating can't
 * drift from the sidebar's link-hiding. Each entry maps a `/dashboard/...` path
 * prefix to the flag(s) that must be enabled to reach it; the longest matching
 * prefix wins. A `requiresFeature` declared in `definePageMeta` still takes
 * precedence (explicit override). Sections NOT listed here are always-on
 * built-ins (the email editor/blocks/media, files, contacts/audience,
 * settings, the dashboard root) and intentionally stay reachable.
 *
 * Mirrors the feature conditionals in `layouts/dashboard.vue`'s nav.
 */
export const PATH_FEATURE_RULES: ReadonlyArray<{ prefix: string; required?: FeatureFlagKey | FeatureFlagKey[]; anyOf?: FeatureFlagKey[] }> = [
	{ prefix: '/dashboard/campaigns', required: 'campaigns' },
	{ prefix: '/dashboard/automations', required: 'automations' },
	{ prefix: '/dashboard/visualizations', required: 'ai.visualizations' },
	{ prefix: '/dashboard/mail/marketing', required: 'campaigns' },
	{ prefix: '/dashboard/mail/transactional', required: 'transactional' },
	// The transactional editor tree lives outside /dashboard/mail/* (at
	// /dashboard/transactional/[id]/{edit,sends/[sendId],translations}) and must
	// be gated too — otherwise the editor is reachable by URL when the flag is off.
	{ prefix: '/dashboard/transactional', required: 'transactional' },
	{ prefix: '/dashboard/knowledge', required: 'ai.knowledge' },
	{ prefix: '/dashboard/inbox', required: 'inbox' },
	{ prefix: '/dashboard/chat', required: 'chat' },
	{ prefix: '/dashboard/postbox', anyOf: ['postbox', 'mail.external'] },
];

export function pathRule(path: string) {
	let best: (typeof PATH_FEATURE_RULES)[number] | undefined;
	for (const rule of PATH_FEATURE_RULES) {
		if (
			(path === rule.prefix || path.startsWith(rule.prefix + '/')) &&
			(!best || rule.prefix.length > best.prefix.length)
		) {
			best = rule;
		}
	}
	return best;
}

export default defineNuxtRouteMiddleware((to) => {
	// Explicit page meta takes precedence; otherwise derive the requirement from
	// the route path so a new page under a gated section is covered by default.
	let required = to.meta.requiresFeature as FeatureFlagKey | FeatureFlagKey[] | undefined;
	let anyOf = to.meta.requiresAnyFeature as FeatureFlagKey[] | undefined;

	if (!required && (!anyOf || anyOf.length === 0) && !to.meta.publicFeature) {
		const rule = pathRule(to.path);
		if (rule) {
			required = rule.required;
			anyOf = rule.anyOf;
		}
	}

	if (!required && (!anyOf || anyOf.length === 0)) return;

	// Don't bounce if we're already on the dashboard root — avoids redirect loops.
	if (to.path === '/dashboard') return;

	const { isEnabled, isLoading } = useFeatureFlag();

	// Flags load asynchronously via a Convex subscription. On a hard reload /
	// direct deep-link the subscription hasn't delivered yet, so isEnabled()
	// falls back to defaults — and many features default OFF (automations, inbox,
	// chat, postbox, ai.*). Bouncing here would redirect users AWAY from features
	// they actually have enabled. Only gate once flags are confirmed loaded; the
	// nav already hides disabled links and feature data is empty when off, so a
	// page rendering briefly during load is harmless (flags are product gating,
	// not an access-control boundary — the backend enforces real access).
	if (isLoading.value) return;

	// AND group — every listed flag must be enabled.
	if (required) {
		const flags = Array.isArray(required) ? required : [required];
		const blocked = flags.find((flag) => !isEnabled(flag));
		if (blocked) {
			return navigateTo({ path: '/dashboard', query: { disabled: blocked } }, { replace: true });
		}
	}

	// OR group — at least one listed flag must be enabled.
	if (anyOf && anyOf.length > 0 && !anyOf.some((flag) => isEnabled(flag))) {
		return navigateTo({ path: '/dashboard', query: { disabled: anyOf[0] } }, { replace: true });
	}
});
