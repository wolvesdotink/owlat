/**
 * Pure model for the dashboard sidebar and settings navigation.
 *
 * The core destinations are declared here once, in their canonical order, each
 * carrying its own feature-flag gate. `buildNavigationSections` registers the
 * core entries first through the host merge (`mergeHostedNavigation`) and then
 * appends plugin contributions — sidebar `navItems` targeting an existing core
 * section and workspace `settingsPanels` — deterministically after every core
 * entry. Core membership, order and gating are therefore identical to the old
 * hand-rolled builder (pinned by `__tests__/dashboardNavigation.test.ts`);
 * plugins can add destinations but never reorder or shadow core ones.
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
import type { OrganizationRole } from '~/composables/useOrganization';

/**
 * A sidebar destination. `name` is an i18n KEY for every CORE entry — this
 * module is module scope and cannot call `useI18n`, so the sidebar and the
 * command palette translate it. A PLUGIN-contributed entry carries the
 * manifest's own (clamped) label instead; `t()` hands an unknown key straight
 * back, so a plugin still renders the words it shipped.
 */
export interface NavigationItem {
	name: string;
	href: string;
	icon: string;
}

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

/** The environment the pure builder reads: role, resolved flags, and desktop context. */
export interface NavigationEnvironment {
	isFeatureEnabled(flag: FeatureFlagKey): boolean;
	isDesktop: boolean;
	role: OrganizationRole | null;
}

type Gate = (env: NavigationEnvironment) => boolean;

const always: Gate = () => true;
const flag =
	(key: FeatureFlagKey): Gate =>
	(env) =>
		env.isFeatureEnabled(key);
const anyFlag =
	(...keys: readonly FeatureFlagKey[]): Gate =>
	(env) =>
		keys.some((key) => env.isFeatureEnabled(key));
const desktopOnly: Gate = (env) => env.isDesktop;
const ROLE_RANK: Record<OrganizationRole, number> = { editor: 0, admin: 1, owner: 2 };
export const minRole =
	(minimum: OrganizationRole): Gate =>
	(env) =>
		env.role !== null && ROLE_RANK[env.role] >= ROLE_RANK[minimum];
const adminOnly = minRole('admin');
const editorOnly: Gate = (env) => env.role === 'editor';

interface CoreItem extends NavigationItem {
	readonly gate?: Gate;
}

interface CoreSection {
	readonly key: SectionKey;
	readonly name: string;
	readonly icon: string;
	readonly href?: string;
	readonly gate?: Gate;
	readonly items: readonly CoreItem[];
}

/**
 * The canonical core navigation, registered first and in this exact order.
 * Every conditional destination keeps the same gate it had in the previous
 * hand-rolled builder, so no membership or ordering changes.
 */
const CORE_SECTIONS: readonly CoreSection[] = [
	{
		key: 'inbox',
		name: 'shared.dashboardNavigation.sections.inbox',
		icon: 'lucide:inbox',
		gate: flag('inbox'),
		items: [
			{
				name: 'shared.dashboardNavigation.items.inbox.allThreads',
				href: '/dashboard/inbox',
				icon: 'lucide:message-square',
			},
			{
				name: 'shared.dashboardNavigation.items.inbox.allActivity',
				href: '/dashboard/inbox/activity',
				icon: 'lucide:activity',
			},
			{
				name: 'shared.dashboardNavigation.items.inbox.reviewQueue',
				href: '/dashboard/inbox/review',
				icon: 'lucide:check-circle',
				gate: adminOnly,
			},
			{
				name: 'shared.dashboardNavigation.items.inbox.codeTasks',
				href: '/dashboard/inbox/code-tasks',
				icon: 'lucide:code',
				gate: (env) => adminOnly(env) && flag('inbox.codeTasks')(env),
			},
			{
				name: 'shared.dashboardNavigation.items.inbox.quarantine',
				href: '/dashboard/inbox/quarantine',
				icon: 'lucide:shield-alert',
				gate: adminOnly,
			},
		],
	},
	{
		key: 'postbox',
		name: 'shared.dashboardNavigation.sections.postbox',
		icon: 'lucide:mailbox',
		href: '/dashboard/postbox',
		gate: anyFlag('postbox', 'mail.external'),
		// Every postbox page renders its own folder rail, so the sidebar shows one
		// flat link; these items are palette-only.
		items: [
			{
				name: 'shared.dashboardNavigation.items.postbox.inbox',
				href: '/dashboard/postbox/inbox',
				icon: 'lucide:inbox',
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.sent',
				href: '/dashboard/postbox/sent',
				icon: 'lucide:send',
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.drafts',
				href: '/dashboard/postbox/drafts',
				icon: 'lucide:file-edit',
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.spam',
				href: '/dashboard/postbox/spam',
				icon: 'lucide:shield-alert',
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.trash',
				href: '/dashboard/postbox/trash',
				icon: 'lucide:trash',
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.preferences',
				href: '/dashboard/preferences',
				icon: 'lucide:settings',
			},
		],
	},
	{
		key: 'chat',
		name: 'shared.dashboardNavigation.sections.chat',
		icon: 'lucide:message-circle',
		href: '/dashboard/chat',
		gate: (env) => adminOnly(env) && flag('chat')(env),
		items: [
			{
				name: 'shared.dashboardNavigation.items.chat.messages',
				href: '/dashboard/chat',
				icon: 'lucide:message-circle',
			},
		],
	},
	{
		key: 'assistant',
		name: 'shared.dashboardNavigation.sections.assistant',
		icon: 'lucide:sparkles',
		href: '/dashboard/assistant',
		gate: (env) => adminOnly(env) && flag('ai.assistant')(env),
		items: [
			{
				name: 'shared.dashboardNavigation.items.assistant.chat',
				href: '/dashboard/assistant',
				icon: 'lucide:sparkles',
			},
		],
	},
	{
		// Unified "Send" section: everything you send from, in one place.
		key: 'send',
		name: 'shared.dashboardNavigation.sections.send',
		icon: 'lucide:send',
		items: [
			{
				name: 'shared.dashboardNavigation.items.send.campaigns',
				href: '/dashboard/campaigns',
				icon: 'lucide:megaphone',
				gate: flag('campaigns'),
			},
			{
				name: 'shared.dashboardNavigation.items.send.automations',
				href: '/dashboard/automations',
				icon: 'lucide:zap',
				gate: (env) => adminOnly(env) && flag('automations')(env),
			},
			{
				name: 'shared.dashboardNavigation.items.send.transactional',
				href: '/dashboard/send/transactional',
				icon: 'lucide:file-code',
				gate: (env) => adminOnly(env) && flag('transactional')(env),
			},
			{
				name: 'shared.dashboardNavigation.items.send.templatesAndBlocks',
				href: '/dashboard/send',
				icon: 'lucide:layout-grid',
				gate: adminOnly,
			},
		],
	},
	{
		key: 'audience',
		name: 'shared.dashboardNavigation.sections.audience',
		icon: 'lucide:users',
		href: undefined,
		items: [
			{
				name: 'shared.dashboardNavigation.items.audience.overview',
				href: '/dashboard/audience',
				icon: 'lucide:layout-dashboard',
				gate: adminOnly,
			},
			{
				name: 'shared.dashboardNavigation.items.audience.contacts',
				href: '/dashboard/audience/contacts',
				icon: 'lucide:users',
			},
			{
				name: 'shared.dashboardNavigation.items.audience.topics',
				href: '/dashboard/audience/topics',
				icon: 'lucide:list-filter',
				gate: adminOnly,
			},
			{
				name: 'shared.dashboardNavigation.items.audience.segments',
				href: '/dashboard/audience/segments',
				icon: 'lucide:user-plus',
				gate: adminOnly,
			},
			{
				name: 'shared.dashboardNavigation.items.audience.suppressions',
				href: '/dashboard/audience/suppressions',
				icon: 'lucide:ban',
			},
		],
	},
	{
		key: 'knowledge',
		name: 'shared.dashboardNavigation.sections.knowledge',
		icon: 'lucide:brain',
		gate: (env) => adminOnly(env) && flag('ai.knowledge')(env),
		items: [
			{
				name: 'shared.dashboardNavigation.items.knowledge.explorer',
				href: '/dashboard/knowledge',
				icon: 'lucide:brain',
			},
			{
				name: 'shared.dashboardNavigation.items.knowledge.graph',
				href: '/dashboard/knowledge/graph',
				icon: 'lucide:share-2',
				gate: flag('ai.knowledge.analytics'),
			},
		],
	},
	{
		key: 'administration',
		name: 'shared.dashboardNavigation.sections.administration',
		icon: 'lucide:shield-check',
		gate: adminOnly,
		items: [
			{
				name: 'shared.dashboardNavigation.items.administration.overview',
				href: '/dashboard/admin',
				icon: 'lucide:gauge',
			},
			{
				name: 'shared.dashboardNavigation.items.administration.delivery',
				href: '/dashboard/admin/delivery',
				icon: 'lucide:truck',
			},
			{
				name: 'shared.dashboardNavigation.items.administration.teamAccess',
				href: '/dashboard/admin/team',
				icon: 'lucide:users-round',
			},
			{
				name: 'shared.dashboardNavigation.items.administration.instance',
				href: '/dashboard/admin/instance',
				icon: 'lucide:server-cog',
			},
		],
	},
	{
		key: 'preferences',
		name: 'shared.dashboardNavigation.sections.preferences',
		icon: 'lucide:settings',
		href: '/dashboard/preferences',
		items: [
			{
				name: 'shared.dashboardNavigation.items.preferences.overview',
				href: '/dashboard/preferences',
				icon: 'lucide:settings',
			},
			{
				name: 'shared.dashboardNavigation.items.preferences.account',
				href: '/dashboard/preferences/account',
				icon: 'lucide:user-cog',
			},
			{
				name: 'shared.dashboardNavigation.items.preferences.filters',
				href: '/dashboard/preferences/filters',
				icon: 'lucide:list-filter',
				gate: anyFlag('postbox', 'mail.external'),
			},
			{
				name: 'shared.dashboardNavigation.items.preferences.signatures',
				href: '/dashboard/preferences/signatures',
				icon: 'lucide:signature',
				gate: anyFlag('postbox', 'mail.external'),
			},
			{
				name: 'shared.dashboardNavigation.items.preferences.connectedMailboxes',
				href: '/dashboard/preferences/external-account',
				icon: 'lucide:mail-plus',
				gate: anyFlag('postbox', 'mail.external'),
			},
			{
				name: 'shared.dashboardNavigation.items.preferences.desktop',
				href: '/desktop/settings',
				icon: 'lucide:monitor',
				gate: desktopOnly,
			},
		],
	},
];

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
