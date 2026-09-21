/**
 * Palette navigation targets projected out of the BREADCRUMB route table.
 *
 * The sidebar lists ~40 destinations; `lib/breadcrumbRoutes.ts` already labels
 * every dashboard page the IA knows about, including the admin leaves the
 * sidebar deliberately hides behind a hub (AI provider, webhooks, ramp
 * controls, audit log, …). Those pages were unreachable from ⌘K at all, so the
 * palette's promise — "every route is one keystroke away" — was false.
 *
 * This module turns that table into palette targets:
 *   - anything the sidebar already contributes is dropped (dedupe by href), so
 *     the sidebar's own wording and icon keep winning;
 *   - what is left is gated the same way the sidebar gates its sections, by the
 *     SAME pure environment (`NavigationEnvironment`) — a member never gets an
 *     admin destination offered, and a disabled feature takes its pages with it;
 *   - Preferences is skipped entirely: the sidebar derives those from the
 *     settings registry, and the breadcrumb table's copy also carries the hidden
 *     wizard entries the registry keeps out of navigation on purpose.
 *
 * Labels stay i18n KEYS (this module is module scope and cannot call `useI18n`,
 * exactly like the tables it reads) — `useCommandPaletteProviders` resolves
 * them.
 */
import type { NavigationEnvironment } from './dashboardNavigationCore';
import { minRole } from './dashboardNavigationCore';
import { routeConfigs } from './breadcrumbRoutes';

/** One labelled destination the palette can offer, as message keys. */
export interface RoutePaletteTarget {
	/** Route path — also the dedupe key against the sidebar's own items. */
	href: string;
	/** Message key for the row label (the page, or the section for a root). */
	labelKey: string;
	/**
	 * Message key for the muted trail line under it — the crumb one level above
	 * the label. Absent on a section root, where the label is the whole trail.
	 */
	contextKey?: string;
	/** Lucide icon, chosen from the section the route belongs to. */
	icon: string;
}

const adminOnly = minRole('admin');
const never = () => false;

/**
 * Gate per route SUBTREE, longest matching prefix wins. Each one mirrors the
 * gate the sidebar puts on the same area in `dashboardNavigationCore`, so the
 * palette can never offer a destination the sidebar would refuse to show.
 */
const SUBTREE_GATES: ReadonlyArray<readonly [string, (env: NavigationEnvironment) => boolean]> = [
	['/dashboard/admin', adminOnly],
	['/dashboard/send', adminOnly],
	['/dashboard/audience', adminOnly],
	['/dashboard/campaigns', (env) => env.isFeatureEnabled('campaigns')],
	['/dashboard/automations', (env) => adminOnly(env) && env.isFeatureEnabled('automations')],
	// Owned by the settings registry (see the module doc).
	['/dashboard/preferences', never],
];

/** Section key → icon, so a palette row is not a wall of identical glyphs. */
const SECTION_ICONS: Readonly<Record<string, string>> = {
	'shared.breadcrumbRoutes.sections.dashboard': 'lucide:layout-dashboard',
	'shared.breadcrumbRoutes.sections.send': 'lucide:send',
	'shared.breadcrumbRoutes.sections.campaigns': 'lucide:megaphone',
	'shared.breadcrumbRoutes.sections.audience': 'lucide:users',
	'shared.breadcrumbRoutes.sections.administration': 'lucide:shield-check',
	'shared.breadcrumbRoutes.sections.delivery': 'lucide:truck',
	'shared.breadcrumbRoutes.sections.automations': 'lucide:zap',
	'shared.breadcrumbRoutes.sections.preferences': 'lucide:settings',
};

/** Anything whose section is not in the table above. */
const FALLBACK_ICON = 'lucide:corner-down-right';

/**
 * The gate for `href`: the longest matching subtree prefix, or open. Matching is
 * segment-aware (`/dashboard/send` never gates `/dashboard/sender`). Pure.
 */
function gateFor(href: string): (env: NavigationEnvironment) => boolean {
	let best: readonly [string, (env: NavigationEnvironment) => boolean] | null = null;
	for (const entry of SUBTREE_GATES) {
		const [prefix] = entry;
		if (href !== prefix && !href.startsWith(`${prefix}/`)) continue;
		if (!best || prefix.length > best[0].length) best = entry;
	}
	return best ? best[1] : () => true;
}

/**
 * Every labelled route the palette should offer beyond `knownHrefs` (the
 * sidebar's own destinations), gated for `env` and in table order. Pure.
 */
export function routePaletteTargets(
	env: NavigationEnvironment,
	knownHrefs: ReadonlySet<string>
): RoutePaletteTarget[] {
	return Object.entries(routeConfigs)
		.filter(([href]) => !knownHrefs.has(href) && gateFor(href)(env))
		.map(([href, config]) => {
			// The crumb trail, deepest last: the label is where you land, the
			// context is the step above it. A section root (`/dashboard`) is one
			// crumb long and gets no context line rather than repeating itself.
			const trail = [config.section, config.subsection, config.page].filter(
				(key): key is string => key !== undefined
			);
			return {
				href,
				labelKey: trail[trail.length - 1]!,
				...(trail.length > 1 ? { contextKey: trail[trail.length - 2]! } : {}),
				icon: SECTION_ICONS[config.section] ?? FALLBACK_ICON,
			};
		});
}
