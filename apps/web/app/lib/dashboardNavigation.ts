/**
 * Pure model for the dashboard sidebar and settings navigation.
 *
 * The core destinations are declared in their canonical order — each carrying
 * its own feature-flag gate — in the sibling `dashboardNavigationCore.ts`.
 * `buildNavigationSections` registers those core entries first through the host
 * merge (`mergeHostedNavigation`) and then appends plugin contributions —
 * sidebar `navItems` targeting an existing core section and workspace
 * `settingsPanels` — deterministically after every core entry. Core membership,
 * order and gating are therefore identical to the old hand-rolled builder
 * (pinned by `__tests__/dashboardNavigation.test.ts`); plugins can add
 * destinations but never reorder or shadow core ones.
 *
 * Kept as pure functions (no Vue, no Nuxt, no Convex) so the whole matrix of
 * flag combinations and plugin cases is unit-testable without mounting
 * anything. The reactive wiring lives in `useDashboardNavigation`.
 */
import {
	mergeHostedNavigation,
	type BundledPlugin,
	type HostedNavEntry,
	type HostedPluginNavEntry,
} from '@owlat/plugin-host';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import type { SectionKey } from '~/composables/useSidebarState';
import {
	CORE_SECTIONS,
	always,
	editorOnly,
	minRole,
	type CoreSection,
	type NavigationEnvironment,
	type NavigationItem,
} from './dashboardNavigationCore';

export { minRole };
export type { NavigationEnvironment, NavigationItem };

export interface NavigationSection {
	key: SectionKey;
	/** i18n key (see {@link NavigationItem}). */
	name: string;
	icon: string;
	/**
	 * When set, the sidebar renders the section as a single flat link to this
	 * destination instead of a collapsible sub-list — used for surfaces that
	 * carry their own in-page navigation (Postbox's folder rail) or have only
	 * one destination (Chat, Assistant). `items` still feeds the command palette
	 * so every destination stays reachable from ⌘K.
	 */
	href?: string;
	items: NavigationItem[];
}

/** Which core section a plugin nav item may attach to. */
const CORE_SECTION_KEYS = new Set<string>(CORE_SECTIONS.map((section) => section.key));

/**
 * Section keys that existed before the IA restructure and that third-party
 * manifests may still target. The manifest validator only checks the shape of
 * `section` (kebab-case), so a published plugin can legitimately carry a key
 * that no longer exists here; without an alias its destination would be
 * silently dropped by the fail-closed filter below. Both retired keys folded
 * into Administration: `settings` (the Settings section) and `delivery` (the
 * first-class Delivery section, now Administration → Delivery).
 */
const RETIRED_SECTION_ALIASES: Readonly<Record<string, SectionKey>> = Object.freeze({
	settings: 'administration',
	delivery: 'administration',
});

/** A plugin's sidebar destination resolved against a target core section. */
export interface PluginNavContribution extends HostedPluginNavEntry<NavigationItem> {
	/** Core section key the destination attaches to. */
	readonly section: string;
}

/** A plugin's workspace settings entry (always attaches to the Settings section). */
export type PluginSettingsContribution = HostedPluginNavEntry<NavigationItem>;

export interface PluginNavigationContributions {
	readonly navItems: readonly PluginNavContribution[];
	readonly settingsPanels: readonly PluginSettingsContribution[];
}

const EMPTY_CONTRIBUTIONS: PluginNavigationContributions = Object.freeze({
	navItems: Object.freeze([]),
	settingsPanels: Object.freeze([]),
});

/**
 * Strip control/format characters and clamp a plugin-authored label before
 * rendering. Removing the Unicode `Cc` (C0 and C1 controls, DEL) and `Cf`
 * (format) categories drops not just C0 controls but also zero-width characters
 * and bidi overrides (U+202E) that would otherwise let a plugin visually spoof a
 * core label. Vue escapes HTML, so this is spoofing defense, not XSS defense.
 */
function clampLabel(raw: string): string {
	return raw
		.replace(/\p{Cc}|\p{Cf}/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 64);
}

/**
 * Derive the plugin navigation contributions from the statically composed
 * bundled plugins. Labels are clamped (plugin text is untrusted), hrefs and
 * ids come straight from the manifest (already validated to be safe internal
 * paths), and each entry's `enabled` is resolved from the plugin's feature flag
 * so a disabled plugin contributes nothing. The dedup id is the href, so a
 * plugin entry pointing at a core destination is dropped rather than shadowing
 * it.
 */
export function derivePluginNavigation(
	plugins: readonly BundledPlugin[],
	isFeatureEnabled: (flag: FeatureFlagKey) => boolean
): PluginNavigationContributions {
	const navItems: PluginNavContribution[] = [];
	const settingsPanels: PluginSettingsContribution[] = [];

	for (const { manifest } of plugins) {
		const pluginId = manifest.id;
		const enabled = isFeatureEnabled(`plugin.${pluginId}`);
		const contributes = manifest.contributes;
		if (!contributes) continue;

		contributes.navItems?.forEach((item, index) => {
			navItems.push({
				pluginId,
				section: item.section,
				id: item.href,
				order: item.order ?? index,
				enabled,
				value: { name: clampLabel(item.name), href: item.href, icon: item.icon },
			});
		});

		contributes.settingsPanels?.forEach((panel, index) => {
			settingsPanels.push({
				pluginId,
				id: panel.href,
				order: panel.order ?? index,
				enabled,
				value: { name: clampLabel(panel.name), href: panel.href, icon: panel.icon },
			});
		});
	}

	if (navItems.length === 0 && settingsPanels.length === 0) return EMPTY_CONTRIBUTIONS;
	return { navItems, settingsPanels };
}

/**
 * Build the ordered, deduplicated, flag-gated sidebar sections. Core sections
 * are registered first and keep their canonical order; a plugin nav item is
 * appended to the section it targets (unknown or feature-off sections drop the
 * item, fail-closed) and plugin settings panels are appended to the Settings
 * section.
 */
export function buildNavigationSections(
	env: NavigationEnvironment,
	contributions: PluginNavigationContributions = EMPTY_CONTRIBUTIONS
): NavigationSection[] {
	const sectionTargetedNavItems = contributions.navItems
		.map((item) =>
			RETIRED_SECTION_ALIASES[item.section] === undefined
				? item
				: { ...item, section: RETIRED_SECTION_ALIASES[item.section]! }
		)
		.filter((item) => CORE_SECTION_KEYS.has(item.section));

	const sections = mergeHostedNavigation<CoreSection>({
		core: CORE_SECTIONS.map((section) => ({
			id: section.key,
			enabled: (section.gate ?? always)(env),
			value: section,
		})),
	});

	return sections
		.map((section) => {
			const coreItems: HostedNavEntry<NavigationItem>[] = section.items.map((item) => ({
				id: item.href,
				enabled: (item.gate ?? always)(env),
				value: { name: item.name, href: item.href, icon: item.icon },
			}));

			const pluginItems: HostedPluginNavEntry<NavigationItem>[] = sectionTargetedNavItems.filter(
				(item) => item.section === section.key
			);
			if (section.key === 'administration') pluginItems.push(...contributions.settingsPanels);

			const items = mergeHostedNavigation<NavigationItem>({
				core: coreItems,
				plugins: pluginItems,
			});

			const isMemberAudience = section.key === 'audience' && editorOnly(env);
			return {
				key: section.key,
				name: isMemberAudience ? 'shared.dashboardNavigation.sections.customers' : section.name,
				icon: section.icon,
				...(isMemberAudience
					? { href: '/dashboard/audience/contacts' }
					: section.href === undefined
						? {}
						: { href: section.href }),
				items: [...items],
			};
		})
		.filter((section) => section.items.length > 0);
}
