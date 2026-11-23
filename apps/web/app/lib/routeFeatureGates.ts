/**
 * Which feature flags a dashboard path needs: the one table every "can this
 * link be opened here?" question reads.
 *
 * The global feature middleware bounces a path this table blocks, and every
 * surface that offers a link (the command palette, the getting-started
 * checklist, the setup finale, the phone tab bar) asks the same
 * {@link blockedFeature}, so none of them can offer a page the middleware would
 * send back to the Workbench. A feature gate is declared here and nowhere else:
 * pages carry no feature meta, because a gate in a page file is invisible to
 * the surfaces that link to it.
 *
 * Each rule maps a path prefix to the flags it needs; the longest matching
 * prefix wins, so a deeper rule replaces the one above it instead of adding to
 * it. A rule with neither `required` nor `anyOf` opens its subtree again.
 * Paths no rule covers (the editor, files, contacts, settings, the Workbench)
 * are always on.
 *
 * Pure: no Vue, no Nuxt.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

export interface RouteFeatureRule {
	prefix: string;
	/** Every listed flag must be on. */
	required?: FeatureFlagKey | readonly FeatureFlagKey[];
	/** At least one listed flag must be on. Checked after `required`. */
	anyOf?: readonly FeatureFlagKey[];
}

/** Mail of your own: the hosted Postbox or a connected external account. */
const MAIL: readonly FeatureFlagKey[] = ['postbox', 'mail.external'];

export const ROUTE_FEATURE_RULES: readonly RouteFeatureRule[] = [
	{ prefix: '/dashboard/campaigns', required: 'campaigns' },
	{ prefix: '/dashboard/marketing', required: 'campaigns' },
	// Recently deleted also holds templates, which need no flag; the page gates
	// each of its tabs itself.
	{ prefix: '/dashboard/marketing/deleted' },
	{ prefix: '/dashboard/automations', required: 'automations' },
	{ prefix: '/dashboard/visualizations', required: 'ai.visualizations' },
	// The transactional list and its editor both live under this prefix, so one
	// rule gates the whole tree.
	{ prefix: '/dashboard/send/transactional', required: 'transactional' },
	{ prefix: '/dashboard/knowledge', required: 'ai.knowledge' },
	{ prefix: '/dashboard/knowledge/graph', required: 'ai.knowledge.analytics' },
	{ prefix: '/dashboard/inbox', required: 'inbox' },
	{ prefix: '/dashboard/inbox/code-tasks', required: 'inbox.codeTasks' },
	{ prefix: '/dashboard/chat', required: 'chat' },
	{ prefix: '/dashboard/assistant', required: 'ai.assistant' },
	{ prefix: '/dashboard/postbox', anyOf: MAIL },
	{ prefix: '/dashboard/compose', anyOf: MAIL },
	// The Answer queue itself stays open (it also holds chat mentions); one
	// message opens under Mail, one team thread under the team inbox.
	{ prefix: '/dashboard/answer/m', anyOf: MAIL },
	{ prefix: '/dashboard/answer/t', required: 'inbox' },
	{ prefix: '/dashboard/admin/delivery/activity', required: 'inbox' },
	{ prefix: '/dashboard/admin/delivery/failed', required: 'inbox' },
	{ prefix: '/dashboard/admin/delivery/quarantine', required: 'inbox' },
	{ prefix: '/dashboard/admin/instance/agent-health', required: 'ai.agent' },
	{ prefix: '/dashboard/admin/team/inboxes', anyOf: MAIL },
	{ prefix: '/dashboard/admin/team/saved-replies', anyOf: [...MAIL, 'inbox'] },
	{ prefix: '/dashboard/preferences/add-account', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/aliases', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/app-passwords', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/external-account', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/filters', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/forwarding', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/members', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/signatures', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/snippets', anyOf: [...MAIL, 'inbox'] },
	{ prefix: '/dashboard/preferences/vacation', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/writing-voice', anyOf: MAIL },
	{ prefix: '/dashboard/preferences/ai-clients', required: 'mail.mcp' },
	{ prefix: '/dashboard/preferences/booking', required: 'calendar.booking' },
];

/** A link's path: what the router matches, without its query or fragment. */
function pathOf(href: string): string {
	return href.split(/[?#]/, 1)[0]!;
}

/**
 * The rule for `href`: the longest prefix that matches it segment by segment
 * (`/dashboard/inbox` never gates `/dashboard/inboxes`), or none.
 */
export function routeFeatureRule(href: string): RouteFeatureRule | undefined {
	const path = pathOf(href);
	let best: RouteFeatureRule | undefined;
	for (const rule of ROUTE_FEATURE_RULES) {
		if (path !== rule.prefix && !path.startsWith(`${rule.prefix}/`)) continue;
		if (!best || rule.prefix.length > best.prefix.length) best = rule;
	}
	return best;
}

/**
 * The switched-off flag that keeps `href` from opening, or `null` when it
 * opens. For an OR-group with every flag off, that is its first flag: the one
 * the redirect names.
 */
export function blockedFeature(
	href: string,
	isEnabled: (flag: FeatureFlagKey) => boolean
): FeatureFlagKey | null {
	const rule = routeFeatureRule(href);
	if (!rule) return null;
	if (rule.required) {
		const flags: readonly FeatureFlagKey[] =
			typeof rule.required === 'string' ? [rule.required] : rule.required;
		const off = flags.find((flag) => !isEnabled(flag));
		if (off) return off;
	}
	if (rule.anyOf && rule.anyOf.length > 0 && !rule.anyOf.some((flag) => isEnabled(flag))) {
		return rule.anyOf[0]!;
	}
	return null;
}

/** Whether `href` opens with these flags. */
export function isFeatureReachable(
	href: string,
	isEnabled: (flag: FeatureFlagKey) => boolean
): boolean {
	return blockedFeature(href, isEnabled) === null;
}
