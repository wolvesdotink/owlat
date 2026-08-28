/**
 * The CORE dashboard navigation table: the canonical destinations, their order,
 * and the gate each one is registered behind.
 *
 * Split out of `dashboardNavigation.ts` (which kept growing past the repo's
 * file-size cap as destinations were added) so the declarative table lives on
 * its own and the builder file stays about MERGING — plugin contributions,
 * retired-section aliases, dedup and ordering. Nothing here knows about
 * plugins; nothing in the builder hard-codes a destination.
 *
 * Pure data plus pure gate predicates (no Vue, no Nuxt, no Convex), so the whole
 * matrix of flag/role/desktop combinations stays unit-testable through
 * `buildNavigationSections` — pinned by `__tests__/dashboardNavigation.test.ts`.
 */
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

/** The environment the pure builder reads: role, resolved flags, and desktop context. */
export interface NavigationEnvironment {
	isFeatureEnabled(flag: FeatureFlagKey): boolean;
	isDesktop: boolean;
	role: OrganizationRole | null;
}

type Gate = (env: NavigationEnvironment) => boolean;

export const always: Gate = () => true;
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
export const editorOnly: Gate = (env) => env.role === 'editor';

interface CoreItem extends NavigationItem {
	readonly gate?: Gate;
}

export interface CoreSection {
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
export const CORE_SECTIONS: readonly CoreSection[] = [
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
				name: 'shared.dashboardNavigation.items.preferences.security',
				href: '/dashboard/preferences/security',
				icon: 'lucide:shield-check',
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
