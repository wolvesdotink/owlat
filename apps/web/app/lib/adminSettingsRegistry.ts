/**
 * THE admin table: every Workspace settings destination, the group it belongs
 * to, and the gate it is registered behind.
 *
 * Administration grew the same way Preferences did before `settingsRegistry.ts`
 * existed — one hub per area, each hub hand-listing its own cards, and the
 * breadcrumb table restating the same routes a third time. This module is the
 * one declaration the Settings sidebar's Workspace tab, the admin palette
 * provider and the admin breadcrumbs (`lib/breadcrumbRoutes.ts`) all read, so a
 * page has one name in the nav, the crumb and the palette.
 *
 * The Workspace tab has five groups — Team, Email delivery, AI, Features,
 * System — plus the overview on top. Pages that belong to another page (the
 * four ramp pages under "Advanced", the API quickstart under "API", the AI
 * pages that now redirect into "AI replies") are `hidden`: reachable, crumbed
 * and searchable, but represented in the rail by their `parent`.
 *
 * Pure data plus pure predicates (no Vue, no Nuxt, no Convex), so the whole
 * flag/platform-admin matrix is unit-testable — see
 * `__tests__/adminSettingsRegistry.test.ts`, which also globs
 * `pages/dashboard/admin/` and fails when a page on disk has no entry.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

/** Where the Workspace settings tree lives. Everything under it is registry-owned. */
export const ADMIN_ROOT = '/dashboard/admin';

/**
 * The ambient inputs an admin gate reads. Role is deliberately absent: the whole
 * tree already sits behind the `admin` route middleware, so a gate here answers
 * "does this deployment have this page" rather than "may this person open it".
 */
export interface AdminEnvironment {
	isFeatureEnabled(flag: FeatureFlagKey): boolean;
	/** Deployment-level tooling (operator console, system, backups). */
	isPlatformAdmin: boolean;
	/** This build ships at least one plugin that has settings. */
	hasPlugins: boolean;
	/**
	 * A self-hosted deployment (`deploymentMode === 'selfhost'`). A self-hosted
	 * instance holds exactly one workspace, so the multi-tenant operator console
	 * would only ever show empty tabs there.
	 */
	isSelfHosted: boolean;
}

export type AdminGate = (env: AdminEnvironment) => boolean;

const flag =
	(key: FeatureFlagKey): AdminGate =>
	(env) =>
		env.isFeatureEnabled(key);
const anyFlag =
	(...keys: readonly FeatureFlagKey[]): AdminGate =>
	(env) =>
		keys.some((key) => env.isFeatureEnabled(key));
const platformOnly: AdminGate = (env) => env.isPlatformAdmin;
const withPlugins: AdminGate = (env) => env.hasPlugins;
/** The operator console is for hosted, multi-workspace deployments. */
const multiTenantPlatform: AdminGate = (env) => env.isPlatformAdmin && !env.isSelfHosted;

/** The groups the rail renders as eyebrows, in this order. */
export type AdminAreaKey = 'overview' | 'team' | 'delivery' | 'ai' | 'features' | 'system';

export const ADMIN_AREAS: readonly {
	readonly key: AdminAreaKey;
	readonly titleKey: string;
}[] = [
	{ key: 'overview', titleKey: 'shell.admin.areas.overview' },
	{ key: 'team', titleKey: 'shell.admin.areas.team' },
	{ key: 'delivery', titleKey: 'shell.admin.areas.delivery' },
	{ key: 'ai', titleKey: 'shell.admin.areas.ai' },
	{ key: 'features', titleKey: 'shell.admin.areas.features' },
	{ key: 'system', titleKey: 'shell.admin.areas.system' },
];

/**
 * A live count that earns a rail entry an attention badge. The layout resolves
 * it (it owns the Convex read); the registry only says which count it is.
 */
export type AdminAttentionKey = 'quarantined' | 'failed';

/** One Workspace settings destination. */
export interface AdminEntry {
	readonly id: string;
	readonly path: string;
	/**
	 * i18n KEY for the label — used by the rail, the crumb and the palette alike,
	 * so the three print one string. Module scope cannot call `useI18n`, so every
	 * consumer resolves it at its own render boundary.
	 */
	readonly titleKey: string;
	readonly icon: string;
	readonly area: AdminAreaKey;
	readonly gate?: AdminGate;
	/**
	 * Reachable, crumbed and searchable, but not listed in the rail — the rail
	 * shows its `parent` instead, and marks the parent current while you are here.
	 */
	readonly hidden?: boolean;
	/** Id of the rail entry that stands for this page. Only set on hidden entries. */
	readonly parent?: string;
	/**
	 * The page's hidden children render as tabs above it (the "Advanced" group of
	 * ramp pages is one rail entry with four tabs, not four rail entries).
	 */
	readonly tabs?: boolean;
	/**
	 * Tables that need room (domains, cells) opt out of the settings shell's
	 * reading width.
	 */
	readonly wide?: boolean;
	/** Badge this entry with a live count when it is non-zero. */
	readonly attention?: AdminAttentionKey;
}

/** Breadcrumb page label, by its key leaf. Keeps the table below readable. */
const label = (leaf: string) => `shared.breadcrumbRoutes.pages.${leaf}`;

/**
 * The canonical admin table, in the order the rail renders it. Area grouping is
 * by `area`; ordering within an area is this order. The first visible entry of
 * an area is its lead page: the breadcrumb's group crumb links there.
 */
export const ADMIN_REGISTRY: readonly AdminEntry[] = [
	{
		id: 'overview',
		path: ADMIN_ROOT,
		titleKey: label('overview'),
		icon: 'lucide:gauge',
		area: 'overview',
	},

	// ── Team ─────────────────────────────────────────────────────────────────
	{
		id: 'team',
		path: `${ADMIN_ROOT}/team`,
		titleKey: label('team'),
		icon: 'lucide:users-round',
		area: 'team',
	},
	{
		id: 'inboxes',
		path: `${ADMIN_ROOT}/team/inboxes`,
		titleKey: label('teamInboxes'),
		icon: 'lucide:inbox',
		area: 'team',
		// Same pair the page's `requiresAnyFeature` names.
		gate: anyFlag('postbox', 'mail.external'),
	},
	{
		id: 'senders',
		path: `${ADMIN_ROOT}/team/senders`,
		titleKey: label('campaignSenders'),
		icon: 'lucide:send',
		area: 'team',
	},
	{
		id: 'apiKeys',
		path: `${ADMIN_ROOT}/team/api`,
		titleKey: label('api'),
		icon: 'lucide:key-round',
		area: 'team',
	},
	{
		// One API entry in the rail: the keys page links to the quickstart.
		id: 'apiDocs',
		path: `${ADMIN_ROOT}/team/api/docs`,
		titleKey: label('apiQuickstart'),
		icon: 'lucide:book-open',
		area: 'team',
		hidden: true,
		parent: 'apiKeys',
	},
	{
		id: 'connectedApps',
		path: `${ADMIN_ROOT}/team/connected-apps`,
		titleKey: label('connectedApps'),
		icon: 'lucide:blocks',
		area: 'team',
	},
	{
		id: 'audit',
		path: `${ADMIN_ROOT}/team/audit`,
		titleKey: label('auditLog'),
		icon: 'lucide:scroll-text',
		area: 'team',
	},

	// ── Email delivery ───────────────────────────────────────────────────────
	{
		id: 'delivery',
		path: `${ADMIN_ROOT}/delivery`,
		titleKey: label('health'),
		icon: 'lucide:activity',
		area: 'delivery',
	},
	{
		id: 'domains',
		path: `${ADMIN_ROOT}/delivery/domains`,
		titleKey: label('sendingDomains'),
		icon: 'lucide:globe',
		area: 'delivery',
		wide: true,
	},
	{
		id: 'transport',
		path: `${ADMIN_ROOT}/delivery/transport`,
		titleKey: label('deliveryProvider'),
		icon: 'lucide:truck',
		area: 'delivery',
	},
	{
		id: 'deliverability',
		path: `${ADMIN_ROOT}/delivery/deliverability`,
		titleKey: label('deliverability'),
		icon: 'lucide:shield-check',
		area: 'delivery',
		wide: true,
	},
	{
		id: 'webhooks',
		path: `${ADMIN_ROOT}/delivery/webhooks`,
		titleKey: label('webhooks'),
		icon: 'lucide:webhook',
		area: 'delivery',
	},
	{
		id: 'providerRouting',
		path: `${ADMIN_ROOT}/delivery/provider-routing`,
		titleKey: label('providerRouting'),
		icon: 'lucide:route',
		area: 'delivery',
	},
	// Received mail the pipeline held back or could not process. These used to
	// live under the team inbox, where the people who can act on them would
	// never look; here they carry a badge when something is waiting.
	{
		id: 'quarantine',
		path: `${ADMIN_ROOT}/delivery/quarantine`,
		titleKey: label('quarantine'),
		icon: 'lucide:shield-alert',
		area: 'delivery',
		gate: flag('inbox'),
		attention: 'quarantined',
	},
	{
		id: 'failed',
		path: `${ADMIN_ROOT}/delivery/failed`,
		titleKey: label('failedMessages'),
		icon: 'lucide:alert-triangle',
		area: 'delivery',
		gate: flag('inbox'),
		attention: 'failed',
	},
	{
		id: 'activity',
		path: `${ADMIN_ROOT}/delivery/activity`,
		titleKey: label('activity'),
		icon: 'lucide:radio-tower',
		area: 'delivery',
		gate: flag('inbox'),
	},
	{
		id: 'migrate',
		path: `${ADMIN_ROOT}/delivery/migrate`,
		titleKey: label('migrateFromMailchimp'),
		icon: 'lucide:import',
		area: 'delivery',
	},
	{
		// One rail entry for the four ramp pages; the page itself forwards to
		// the first of them, and the layout renders all four as tabs.
		id: 'advanced',
		path: `${ADMIN_ROOT}/delivery/advanced`,
		titleKey: label('advanced'),
		icon: 'lucide:sliders-horizontal',
		area: 'delivery',
		tabs: true,
	},
	{
		id: 'rampControls',
		path: `${ADMIN_ROOT}/delivery/advanced/controls`,
		titleKey: label('controls'),
		icon: 'lucide:sliders-horizontal',
		area: 'delivery',
		hidden: true,
		parent: 'advanced',
	},
	{
		id: 'cells',
		path: `${ADMIN_ROOT}/delivery/advanced/cells`,
		titleKey: label('cells'),
		icon: 'lucide:grid-3x3',
		area: 'delivery',
		hidden: true,
		parent: 'advanced',
		wide: true,
	},
	{
		id: 'independence',
		path: `${ADMIN_ROOT}/delivery/advanced/independence`,
		titleKey: label('independence'),
		icon: 'lucide:plug',
		area: 'delivery',
		hidden: true,
		parent: 'advanced',
	},
	{
		id: 'measurement',
		path: `${ADMIN_ROOT}/delivery/advanced/measurement`,
		titleKey: label('measurement'),
		icon: 'lucide:target',
		area: 'delivery',
		hidden: true,
		parent: 'advanced',
		wide: true,
	},

	// ── AI ───────────────────────────────────────────────────────────────────
	{
		// Deliberately ungated: this is the page where AI gets turned on, so
		// hiding it behind the `ai` flag would be a chicken-and-egg lockout (the
		// page itself makes the same call in its `definePageMeta`).
		id: 'aiProvider',
		path: `${ADMIN_ROOT}/instance/ai-provider`,
		titleKey: label('aiProvider'),
		icon: 'lucide:sparkles',
		area: 'ai',
	},
	{
		// Gated on `ai`, not `ai.agent`: the page's "Off" choice turns the agent
		// off, and the same page is where it gets turned back on. The old agent
		// and autonomy URLs are redirect stubs into this page.
		id: 'aiReplies',
		path: `${ADMIN_ROOT}/instance/ai-replies`,
		titleKey: label('aiReplies'),
		icon: 'lucide:bot',
		area: 'ai',
		gate: flag('ai'),
	},
	{
		id: 'agentHealth',
		path: `${ADMIN_ROOT}/instance/agent-health`,
		titleKey: label('agentHealth'),
		icon: 'lucide:heart-pulse',
		area: 'ai',
		gate: flag('ai.agent'),
	},

	// ── Features ─────────────────────────────────────────────────────────────
	{
		id: 'features',
		path: `${ADMIN_ROOT}/instance/features`,
		titleKey: label('features'),
		icon: 'lucide:toggle-right',
		area: 'features',
	},
	{
		// The operating-mode picker. It sets feature flags in bulk, so it hangs
		// off Features rather than holding a rail row of its own.
		id: 'instance',
		path: `${ADMIN_ROOT}/instance`,
		titleKey: label('instance'),
		icon: 'lucide:server-cog',
		area: 'features',
		hidden: true,
		parent: 'features',
	},
	{
		id: 'channels',
		path: `${ADMIN_ROOT}/instance/channels`,
		titleKey: label('channels'),
		icon: 'lucide:radio',
		area: 'features',
	},
	{
		id: 'forms',
		path: `${ADMIN_ROOT}/instance/forms`,
		titleKey: label('forms'),
		icon: 'lucide:file-text',
		area: 'features',
	},
	{
		id: 'properties',
		path: `${ADMIN_ROOT}/instance/properties`,
		titleKey: label('contactProperties'),
		icon: 'lucide:tags',
		area: 'features',
	},
	{
		id: 'emailTheme',
		path: `${ADMIN_ROOT}/instance/email-theme`,
		titleKey: label('emailTheme'),
		icon: 'lucide:palette',
		area: 'features',
	},
	{
		id: 'sealedMail',
		path: `${ADMIN_ROOT}/instance/sealed-mail`,
		titleKey: label('sealedMail'),
		icon: 'lucide:lock',
		area: 'features',
		gate: flag('sealedMail'),
	},
	{
		id: 'plugins',
		path: `${ADMIN_ROOT}/instance/plugins`,
		titleKey: label('plugins'),
		icon: 'lucide:puzzle',
		area: 'features',
		gate: withPlugins,
	},

	// ── System ───────────────────────────────────────────────────────────────
	{
		id: 'instanceGeneral',
		path: `${ADMIN_ROOT}/instance/general`,
		titleKey: label('general'),
		icon: 'lucide:building-2',
		area: 'system',
	},
	{
		id: 'desktopUpdates',
		path: `${ADMIN_ROOT}/instance/desktop-updates`,
		titleKey: label('desktopUpdates'),
		icon: 'lucide:monitor-down',
		area: 'system',
	},
	{
		id: 'system',
		path: `${ADMIN_ROOT}/system`,
		titleKey: label('systemAndUpdates'),
		icon: 'lucide:cpu',
		area: 'system',
		gate: platformOnly,
	},
	{
		id: 'backups',
		path: `${ADMIN_ROOT}/backups`,
		titleKey: label('backups'),
		icon: 'lucide:database-backup',
		area: 'system',
		gate: platformOnly,
	},
	{
		id: 'operator',
		path: `${ADMIN_ROOT}/operator`,
		titleKey: label('operatorConsole'),
		icon: 'lucide:shield-alert',
		area: 'system',
		gate: multiTenantPlatform,
		wide: true,
	},
];

/** Registry lookup by path. Undefined for a route the registry does not own. */
export function adminEntryFor(path: string): AdminEntry | undefined {
	return ADMIN_REGISTRY.find((candidate) => candidate.path === path);
}

/** Registry lookup by id. */
export function adminEntryById(id: string): AdminEntry | undefined {
	return ADMIN_REGISTRY.find((candidate) => candidate.id === id);
}

/**
 * The rail entry that stands for `path`: the page itself when it is listed, its
 * parent when it is a hidden child. Undefined outside the registry. Pure.
 */
export function adminRailEntryFor(path: string): AdminEntry | undefined {
	const entry = adminEntryFor(path);
	if (!entry) return undefined;
	return entry.parent ? (adminEntryById(entry.parent) ?? entry) : entry;
}

/** The entries this environment may reach, hidden ones included, in registry order. Pure. */
export function reachableAdminEntries(env: AdminEnvironment): AdminEntry[] {
	return ADMIN_REGISTRY.filter((candidate) => !candidate.gate || candidate.gate(env));
}
