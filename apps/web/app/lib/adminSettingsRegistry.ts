/**
 * THE admin table: every Administration destination, the area it belongs to,
 * and the gate it is registered behind.
 *
 * Administration grew the same way Preferences did before `settingsRegistry.ts`
 * existed — one hub per area, each hub hand-listing its own cards, and the
 * breadcrumb table restating the same routes a third time. The result was a
 * tree you could only walk from the top: Domains → Transport → Webhooks meant
 * two trips through the Delivery hub, and the four ramp pages (`advanced/cells`,
 * `controls`, `independence`, `measurement`) hung off a collapsed disclosure on
 * that hub, so they appeared in no rail, no hub grid and no ⌘K.
 *
 * This module is the one declaration the admin layout's rail and its palette
 * provider read. Titles are the SAME i18n keys `lib/breadcrumbRoutes.ts` prints
 * for each route, so the rail, the crumb and the palette cannot drift into three
 * names for one page.
 *
 * Pure data plus pure predicates (no Vue, no Nuxt, no Convex), so the whole
 * flag/platform-admin matrix is unit-testable — see
 * `__tests__/adminSettingsRegistry.test.ts`, which also globs
 * `pages/dashboard/admin/` and fails when a page on disk has no entry.
 */
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { type PaletteGroup, type PaletteItem, filterItems } from './commandPalette';

/** Where the Administration tree lives. Everything under it is registry-owned. */
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

/** The groups the rail renders as eyebrows, in this order. */
export type AdminAreaKey = 'overview' | 'delivery' | 'advanced' | 'instance' | 'team' | 'platform';

export const ADMIN_AREAS: readonly {
	readonly key: AdminAreaKey;
	readonly titleKey: string;
}[] = [
	{ key: 'overview', titleKey: 'shell.admin.areas.overview' },
	{ key: 'delivery', titleKey: 'shell.admin.areas.delivery' },
	{ key: 'advanced', titleKey: 'shell.admin.areas.advanced' },
	{ key: 'instance', titleKey: 'shell.admin.areas.instance' },
	{ key: 'team', titleKey: 'shell.admin.areas.team' },
	{ key: 'platform', titleKey: 'shell.admin.areas.platform' },
];

/** One Administration destination. */
export interface AdminEntry {
	readonly id: string;
	readonly path: string;
	/**
	 * i18n KEY for the label — the breadcrumb table's own page key, so the rail
	 * and the crumb print one string. Module scope cannot call `useI18n`, so
	 * every consumer resolves it at its own render boundary.
	 */
	readonly titleKey: string;
	readonly icon: string;
	readonly area: AdminAreaKey;
	readonly gate?: AdminGate;
}

/** Breadcrumb page label, by its key leaf. Keeps the table below readable. */
const label = (leaf: string) => `shared.breadcrumbRoutes.pages.${leaf}`;

/**
 * The canonical admin table, in the order the rail renders it. Area grouping is
 * by `area`; ordering within an area is this order. Each area leads with the hub
 * that owns it, because the hub is a real destination (a roll-up), not a menu.
 */
export const ADMIN_REGISTRY: readonly AdminEntry[] = [
	{
		id: 'overview',
		path: ADMIN_ROOT,
		titleKey: label('overview'),
		icon: 'lucide:gauge',
		area: 'overview',
	},

	// ── Delivery ─────────────────────────────────────────────────────────────
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
	{
		id: 'migrate',
		path: `${ADMIN_ROOT}/delivery/migrate`,
		titleKey: label('migrateFromMailchimp'),
		icon: 'lucide:import',
		area: 'delivery',
	},

	// ── Delivery → Advanced ──────────────────────────────────────────────────
	// The ramp pages. They gate how fast this deployment may send, which is not a
	// reasonable thing to fold away behind a disclosure on one hub.
	{
		id: 'rampControls',
		path: `${ADMIN_ROOT}/delivery/advanced/controls`,
		titleKey: label('controls'),
		icon: 'lucide:sliders-horizontal',
		area: 'advanced',
	},
	{
		id: 'cells',
		path: `${ADMIN_ROOT}/delivery/advanced/cells`,
		titleKey: label('cells'),
		icon: 'lucide:grid-3x3',
		area: 'advanced',
	},
	{
		id: 'independence',
		path: `${ADMIN_ROOT}/delivery/advanced/independence`,
		titleKey: label('independence'),
		icon: 'lucide:plug',
		area: 'advanced',
	},
	{
		id: 'measurement',
		path: `${ADMIN_ROOT}/delivery/advanced/measurement`,
		titleKey: label('measurement'),
		icon: 'lucide:target',
		area: 'advanced',
	},

	// ── Instance ─────────────────────────────────────────────────────────────
	{
		id: 'instance',
		path: `${ADMIN_ROOT}/instance`,
		titleKey: label('instance'),
		icon: 'lucide:server-cog',
		area: 'instance',
	},
	{
		id: 'instanceGeneral',
		path: `${ADMIN_ROOT}/instance/general`,
		titleKey: label('general'),
		icon: 'lucide:building-2',
		area: 'instance',
	},
	{
		id: 'features',
		path: `${ADMIN_ROOT}/instance/features`,
		titleKey: label('features'),
		icon: 'lucide:toggle-right',
		area: 'instance',
	},
	{
		id: 'emailTheme',
		path: `${ADMIN_ROOT}/instance/email-theme`,
		titleKey: label('emailTheme'),
		icon: 'lucide:palette',
		area: 'instance',
	},
	{
		id: 'properties',
		path: `${ADMIN_ROOT}/instance/properties`,
		titleKey: label('contactProperties'),
		icon: 'lucide:tags',
		area: 'instance',
	},
	{
		id: 'forms',
		path: `${ADMIN_ROOT}/instance/forms`,
		titleKey: label('forms'),
		icon: 'lucide:file-text',
		area: 'instance',
	},
	{
		id: 'channels',
		path: `${ADMIN_ROOT}/instance/channels`,
		titleKey: label('channels'),
		icon: 'lucide:radio',
		area: 'instance',
	},
	{
		// Deliberately ungated: this is the page where AI gets turned on, so
		// hiding it behind the `ai` flag would be a chicken-and-egg lockout (the
		// page itself makes the same call in its `definePageMeta`).
		id: 'aiProvider',
		path: `${ADMIN_ROOT}/instance/ai-provider`,
		titleKey: label('aiProvider'),
		icon: 'lucide:sparkles',
		area: 'instance',
	},
	{
		id: 'agent',
		path: `${ADMIN_ROOT}/instance/agent`,
		titleKey: label('aiAgent'),
		icon: 'lucide:bot',
		area: 'instance',
		gate: flag('ai.agent'),
	},
	{
		id: 'agentHealth',
		path: `${ADMIN_ROOT}/instance/agent-health`,
		titleKey: label('agentHealth'),
		icon: 'lucide:activity',
		area: 'instance',
		gate: flag('ai.agent'),
	},
	{
		id: 'autonomy',
		path: `${ADMIN_ROOT}/instance/autonomy`,
		titleKey: label('autonomyRules'),
		icon: 'lucide:sliders-horizontal',
		area: 'instance',
		gate: flag('ai.autonomy'),
	},
	{
		id: 'sealedMail',
		path: `${ADMIN_ROOT}/instance/sealed-mail`,
		titleKey: label('secureMail'),
		icon: 'lucide:lock',
		area: 'instance',
		gate: flag('sealedMail'),
	},
	{
		id: 'plugins',
		path: `${ADMIN_ROOT}/instance/plugins`,
		titleKey: label('plugins'),
		icon: 'lucide:puzzle',
		area: 'instance',
		gate: withPlugins,
	},

	// ── Team & access ────────────────────────────────────────────────────────
	{
		id: 'team',
		path: `${ADMIN_ROOT}/team`,
		titleKey: label('teamAccess'),
		icon: 'lucide:users-round',
		area: 'team',
	},
	{
		id: 'apiKeys',
		path: `${ADMIN_ROOT}/team/api`,
		titleKey: label('apiKeys'),
		icon: 'lucide:key-round',
		area: 'team',
	},
	{
		id: 'apiDocs',
		path: `${ADMIN_ROOT}/team/api/docs`,
		titleKey: label('apiQuickstart'),
		icon: 'lucide:book-open',
		area: 'team',
	},
	{
		id: 'senders',
		path: `${ADMIN_ROOT}/team/senders`,
		titleKey: label('campaignSenders'),
		icon: 'lucide:send',
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

	// ── Platform (this deployment, not this workspace) ───────────────────────
	{
		id: 'system',
		path: `${ADMIN_ROOT}/system`,
		titleKey: label('systemAndUpdates'),
		icon: 'lucide:cpu',
		area: 'platform',
		gate: platformOnly,
	},
	{
		id: 'backups',
		path: `${ADMIN_ROOT}/backups`,
		titleKey: label('backups'),
		icon: 'lucide:database-backup',
		area: 'platform',
		gate: platformOnly,
	},
	{
		id: 'operator',
		path: `${ADMIN_ROOT}/operator`,
		titleKey: label('operatorConsole'),
		icon: 'lucide:shield-alert',
		area: 'platform',
		gate: platformOnly,
	},
];

/** Registry lookup by path. Undefined for a route the registry does not own. */
export function adminEntryFor(path: string): AdminEntry | undefined {
	return ADMIN_REGISTRY.find((candidate) => candidate.path === path);
}

/** The entries this environment may reach, in registry order. Pure. */
export function reachableAdminEntries(env: AdminEnvironment): AdminEntry[] {
	return ADMIN_REGISTRY.filter((candidate) => !candidate.gate || candidate.gate(env));
}

export interface AdminAreaView {
	readonly key: AdminAreaKey;
	readonly titleKey: string;
	readonly entries: readonly AdminEntry[];
}

/**
 * The reachable entries grouped into their areas, in registry order, with empty
 * areas dropped — what the layout's rail renders. Pure.
 */
export function adminAreasFor(env: AdminEnvironment): AdminAreaView[] {
	const reachable = reachableAdminEntries(env);
	return ADMIN_AREAS.map((area) => ({
		...area,
		entries: reachable.filter((candidate) => candidate.area === area.key),
	})).filter((area) => area.entries.length > 0);
}

// ── Command palette ─────────────────────────────────────────────────────────

/** Stable registry id (and dedup key) of the admin shell's palette provider. */
export const ADMIN_COMMAND_PROVIDER_ID = 'surface:admin';

/** Orders this provider within the EXTERNAL tier; core is always consulted first. */
export const ADMIN_COMMAND_PROVIDER_PRIORITY = 20;

/** Group key of the admin "jump to another admin page" block. */
export const ADMIN_COMMAND_GROUP_KEY = 'admin-nav';

export interface AdminSurfaceDeps {
	/** The entries the current environment can reach, already gated. */
	entries: () => readonly AdminEntry[];
	/** Translator — the composable owns `useI18n`, this module cannot. */
	t: (key: string) => string;
	/** Area title for the muted line under a row, by area key. */
	areaTitleKey: (area: AdminAreaKey) => string;
	onOpen: (entry: AdminEntry) => void;
}

/**
 * The Administration shell's contextual group: every admin destination the
 * deployment has, while you are standing in the admin tree.
 *
 * The core navigation provider caps at eight rows across the whole app, so from
 * inside Administration the sibling pages you actually want are the ones that
 * fall off the end. This group puts them at the top instead, with their area as
 * the context line. Item ids are the registry's own (`admin:<id>`) rather than
 * the core `nav:<href>` ids: sharing those would make the group dedup itself
 * away to nothing wherever core already offers the route, which here is
 * everywhere. Pure.
 */
export function buildAdminSurfaceGroups(deps: AdminSurfaceDeps, query: string): PaletteGroup[] {
	const items: PaletteItem[] = deps.entries().map((entry) => ({
		id: `admin:${entry.id}`,
		label: deps.t(entry.titleKey),
		subtitle: deps.t(deps.areaTitleKey(entry.area)),
		icon: entry.icon,
		run: () => deps.onOpen(entry),
	}));
	return [
		{
			key: ADMIN_COMMAND_GROUP_KEY,
			heading: deps.t('shell.admin.paletteHeading'),
			// Above the core verbs (order 5): where you are is what you are moving
			// around in.
			order: 1,
			cap: 8,
			mode: 'commands',
			items: filterItems(items, query),
		},
	];
}
