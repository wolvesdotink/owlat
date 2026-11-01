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
import { SETTINGS_REGISTRY } from './settingsRegistry';
import {
	BrainIcon,
	ChartBarVerticalIcon,
	ChatCircleIcon,
	ChatIcon,
	CircleCheckIcon,
	CircleSlashIcon,
	CodeIcon,
	FileCodeIcon,
	FileEditIcon,
	FileSearchIcon,
	GaugeIcon,
	GridIcon,
	InboxIcon,
	ListFilterIcon,
	MailboxIcon,
	MegaphoneIcon,
	PaperPlaneIcon,
	ReplyAllIcon,
	ServerIcon,
	SettingsIcon,
	ShareIcon,
	ShieldCheckIcon,
	ShieldWarningIcon,
	SparklesIcon,
	TrashIcon,
	TruckIcon,
	UserPlusCornerIcon,
	UsersIcon,
	ZapIcon,
	type IconComponent,
} from '@coolicons/vue';

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
	icon: IconComponent;
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
const ROLE_RANK: Record<OrganizationRole, number> = { editor: 0, admin: 1, owner: 2 };
export const minRole =
	(minimum: OrganizationRole): Gate =>
	(env) =>
		env.role !== null && ROLE_RANK[env.role] >= ROLE_RANK[minimum];
const adminOnly = minRole('admin');
export const editorOnly: Gate = (env) => env.role === 'editor';

/**
 * Recently deleted holds what the viewer could restore: campaigns (every role
 * manages them, behind their flag) or templates and automations (admins).
 */
export const recentlyDeletedGate: Gate = (env) => flag('campaigns')(env) || adminOnly(env);

interface CoreItem extends NavigationItem {
	readonly gate?: Gate;
}

export interface CoreSection {
	readonly key: SectionKey;
	readonly name: string;
	readonly icon: IconComponent;
	readonly href?: string;
	readonly gate?: Gate;
	readonly items: readonly CoreItem[];
}

/**
 * The Preferences destinations, projected out of the settings registry so the
 * sidebar/palette table and the Preferences IA cannot drift apart again. A
 * hidden entry (a wizard you enter from a button) is left out; everything else
 * keeps its own registry gate, which is a strict subset of a navigation gate.
 */
const PREFERENCES_ITEMS: readonly CoreItem[] = SETTINGS_REGISTRY.filter(
	(entry) => !entry.hidden
).map((entry) => ({
	name: entry.titleKey,
	href: entry.path,
	icon: entry.icon,
	...(entry.gate ? { gate: entry.gate } : {}),
}));

/**
 * The canonical core navigation, registered first and in this exact order.
 * Every conditional destination keeps the same gate it had in the previous
 * hand-rolled builder, so no membership or ordering changes.
 */
export const CORE_SECTIONS: readonly CoreSection[] = [
	{
		key: 'inbox',
		name: 'shared.dashboardNavigation.sections.inbox',
		icon: InboxIcon,
		gate: flag('inbox'),
		items: [
			{
				name: 'shared.dashboardNavigation.items.inbox.allThreads',
				href: '/dashboard/inbox',
				icon: ChatIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.inbox.reviewQueue',
				href: '/dashboard/answer?in=team',
				icon: CircleCheckIcon,
				gate: adminOnly,
			},
			{
				name: 'shared.dashboardNavigation.items.inbox.codeTasks',
				href: '/dashboard/inbox/code-tasks',
				icon: CodeIcon,
				gate: (env) => adminOnly(env) && flag('inbox.codeTasks')(env),
			},
		],
	},
	{
		key: 'postbox',
		name: 'shared.dashboardNavigation.sections.postbox',
		icon: MailboxIcon,
		href: '/dashboard/postbox',
		gate: anyFlag('postbox', 'mail.external'),
		// The Conversations sidebar renders the inboxes themselves; these items
		// are palette-only destinations.
		items: [
			{
				name: 'shared.dashboardNavigation.items.postbox.answerQueue',
				href: '/dashboard/answer',
				icon: ReplyAllIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.allInboxes',
				href: '/dashboard/inboxes',
				icon: InboxIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.inbox',
				href: '/dashboard/postbox/inbox',
				icon: InboxIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.sent',
				href: '/dashboard/postbox/sent',
				icon: PaperPlaneIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.drafts',
				href: '/dashboard/postbox/drafts',
				icon: FileEditIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.spam',
				href: '/dashboard/postbox/spam',
				icon: ShieldWarningIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.trash',
				href: '/dashboard/postbox/trash',
				icon: TrashIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.postbox.preferences',
				href: '/dashboard/preferences',
				icon: SettingsIcon,
			},
		],
	},
	{
		key: 'chat',
		name: 'shared.dashboardNavigation.sections.chat',
		icon: ChatCircleIcon,
		href: '/dashboard/chat',
		gate: (env) => adminOnly(env) && flag('chat')(env),
		items: [
			{
				name: 'shared.dashboardNavigation.items.chat.messages',
				href: '/dashboard/chat',
				icon: ChatCircleIcon,
			},
		],
	},
	{
		key: 'assistant',
		name: 'shared.dashboardNavigation.sections.assistant',
		icon: SparklesIcon,
		href: '/dashboard/assistant',
		// Every member, like the route: the user menu and ⌘J offer it to all.
		gate: flag('ai.assistant'),
		items: [
			{
				name: 'shared.dashboardNavigation.items.assistant.chat',
				href: '/dashboard/assistant',
				icon: SparklesIcon,
			},
		],
	},
	{
		// The Marketing workspace: everything you send to an audience. Named with
		// the breadcrumb's own section key, so the palette's context line, the
		// trail and the sidebar switch say the same word.
		key: 'send',
		name: 'shared.breadcrumbRoutes.sections.marketing',
		icon: PaperPlaneIcon,
		items: [
			{
				name: 'shared.dashboardNavigation.items.send.overview',
				href: '/dashboard/marketing',
				icon: ChartBarVerticalIcon,
				gate: flag('campaigns'),
			},
			{
				name: 'shared.dashboardNavigation.items.send.campaigns',
				href: '/dashboard/campaigns',
				icon: MegaphoneIcon,
				gate: flag('campaigns'),
			},
			{
				name: 'shared.dashboardNavigation.items.send.automations',
				href: '/dashboard/automations',
				icon: ZapIcon,
				gate: (env) => adminOnly(env) && flag('automations')(env),
			},
			{
				name: 'shared.dashboardNavigation.items.send.transactional',
				href: '/dashboard/send/transactional',
				icon: FileCodeIcon,
				gate: (env) => adminOnly(env) && flag('transactional')(env),
			},
			{
				name: 'shared.dashboardNavigation.items.send.templates',
				href: '/dashboard/send',
				icon: GridIcon,
				gate: adminOnly,
			},
			{
				name: 'shared.dashboardNavigation.items.send.recentlyDeleted',
				href: '/dashboard/marketing/deleted',
				icon: TrashIcon,
				gate: recentlyDeletedGate,
			},
		],
	},
	{
		key: 'audience',
		name: 'shared.dashboardNavigation.sections.audience',
		icon: UsersIcon,
		href: undefined,
		items: [
			{
				name: 'shared.dashboardNavigation.items.audience.contacts',
				href: '/dashboard/audience/contacts',
				icon: UsersIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.audience.topics',
				href: '/dashboard/audience/topics',
				icon: ListFilterIcon,
				gate: adminOnly,
			},
			{
				name: 'shared.dashboardNavigation.items.audience.segments',
				href: '/dashboard/audience/segments',
				icon: UserPlusCornerIcon,
				gate: adminOnly,
			},
			{
				name: 'shared.dashboardNavigation.items.audience.suppressions',
				href: '/dashboard/audience/suppressions',
				icon: CircleSlashIcon,
			},
		],
	},
	{
		key: 'knowledge',
		name: 'shared.dashboardNavigation.sections.knowledge',
		icon: BrainIcon,
		// Every member: Knowledge sits in the Conversations sidebar next to Chat.
		gate: flag('ai.knowledge'),
		items: [
			{
				name: 'shared.dashboardNavigation.items.knowledge.explorer',
				href: '/dashboard/knowledge',
				icon: BrainIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.knowledge.graph',
				href: '/dashboard/knowledge/graph',
				icon: ShareIcon,
				gate: flag('ai.knowledge.analytics'),
			},
			{
				// The semantic file library the assistant's searchFiles tool reads.
				// Nothing else links to it since the Templates overview went away.
				name: 'shared.dashboardNavigation.items.knowledge.files',
				href: '/dashboard/files',
				icon: FileSearchIcon,
			},
		],
	},
	{
		key: 'administration',
		name: 'shared.dashboardNavigation.sections.administration',
		icon: ShieldCheckIcon,
		gate: adminOnly,
		items: [
			{
				name: 'shared.dashboardNavigation.items.administration.overview',
				href: '/dashboard/admin',
				icon: GaugeIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.administration.delivery',
				href: '/dashboard/admin/delivery',
				icon: TruckIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.administration.teamAccess',
				href: '/dashboard/admin/team',
				icon: UsersIcon,
			},
			{
				name: 'shared.dashboardNavigation.items.administration.instance',
				href: '/dashboard/admin/instance',
				icon: ServerIcon,
			},
		],
	},
	{
		key: 'preferences',
		// The same name the Settings tab and the breadcrumb use ("My settings").
		name: 'shared.breadcrumbRoutes.sections.preferences',
		icon: SettingsIcon,
		href: '/dashboard/preferences',
		// Every Preferences page renders the layout's own left nav, so the sidebar
		// shows one flat link; these items are palette-only. They are DERIVED from
		// the settings registry rather than restated here — the hand-maintained
		// copy had already lost aliases, vacation, snippets, writing voice and app
		// passwords, which made them unreachable from ⌘K.
		items: PREFERENCES_ITEMS,
	},
];

/**
 * Every href the core table declares. The sidebar renders core destinations as
 * the workspace's own rows, so anything outside this set is a plugin
 * contribution it lists separately.
 */
export const CORE_NAV_HREFS: ReadonlySet<string> = new Set(
	CORE_SECTIONS.flatMap((section) => [
		...(section.href ? [section.href] : []),
		...section.items.map((item) => item.href),
	])
);
