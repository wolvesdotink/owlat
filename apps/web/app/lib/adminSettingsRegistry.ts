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
import { anyFlag, flag, platformOnly, rampStarted, withPlugins } from './adminSettingsGates';
import type { AdminEntry, AdminEnvironment } from './adminSettingsTypes';
import {
	ActivityIcon,
	BookOpenIcon,
	BroadcastIcon,
	Building2Icon,
	ChatTextIcon,
	ComponentIcon,
	CpuIcon,
	DatabaseIcon,
	DownloadIcon,
	FileSearchIcon,
	FileTextIcon,
	GaugeIcon,
	GlobeIcon,
	GridAltIcon,
	HeartPulseIcon,
	InboxIcon,
	KeyIcon,
	LockIcon,
	MonitorIcon,
	PaletteIcon,
	PaperPlaneIcon,
	PlugIcon,
	PuzzleIcon,
	RobotIcon,
	RouteIcon,
	ServerIcon,
	ShieldCheckIcon,
	ShieldWarningIcon,
	Slider1Icon,
	SparklesIcon,
	TagsIcon,
	TargetIcon,
	ToggleRightIcon,
	TriangleWarningIcon,
	TruckIcon,
	UsersIcon,
	WebhookIcon,
} from '@coolicons/vue';

export {
	ADMIN_AREAS,
	type AdminAreaKey,
	type AdminAttentionKey,
	type AdminEntry,
	type AdminEnvironment,
	type AdminGate,
} from './adminSettingsTypes';

/** Where the Workspace settings tree lives. Everything under it is registry-owned. */
export const ADMIN_ROOT = '/dashboard/admin';

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
		icon: GaugeIcon,
		area: 'overview',
	},

	// ── Team ─────────────────────────────────────────────────────────────────
	{
		id: 'team',
		path: `${ADMIN_ROOT}/team`,
		titleKey: label('team'),
		icon: UsersIcon,
		area: 'team',
	},
	{
		id: 'inboxes',
		path: `${ADMIN_ROOT}/team/inboxes`,
		titleKey: label('teamInboxes'),
		icon: InboxIcon,
		area: 'team',
		// Same pair the page's `requiresAnyFeature` names.
		gate: anyFlag('postbox', 'mail.external'),
	},
	{
		id: 'savedReplies',
		path: `${ADMIN_ROOT}/team/saved-replies`,
		titleKey: label('savedReplies'),
		icon: ChatTextIcon,
		area: 'team',
		// Same set the page's `requiresAnyFeature` names.
		gate: anyFlag('postbox', 'mail.external', 'inbox'),
	},
	{
		id: 'senders',
		path: `${ADMIN_ROOT}/team/senders`,
		titleKey: label('campaignSenders'),
		icon: PaperPlaneIcon,
		area: 'team',
	},
	{
		id: 'apiKeys',
		path: `${ADMIN_ROOT}/team/api`,
		titleKey: label('api'),
		icon: KeyIcon,
		area: 'team',
	},
	{
		// One API entry in the rail: the keys page links to the quickstart.
		id: 'apiDocs',
		path: `${ADMIN_ROOT}/team/api/docs`,
		titleKey: label('apiQuickstart'),
		icon: BookOpenIcon,
		area: 'team',
		hidden: true,
		parent: 'apiKeys',
	},
	{
		id: 'connectedApps',
		path: `${ADMIN_ROOT}/team/connected-apps`,
		titleKey: label('connectedApps'),
		icon: ComponentIcon,
		area: 'team',
	},
	{
		id: 'audit',
		path: `${ADMIN_ROOT}/team/audit`,
		titleKey: label('auditLog'),
		icon: FileTextIcon,
		area: 'team',
	},

	// ── Email delivery ───────────────────────────────────────────────────────
	{
		id: 'delivery',
		path: `${ADMIN_ROOT}/delivery`,
		titleKey: label('health'),
		icon: ActivityIcon,
		area: 'delivery',
	},
	{
		id: 'domains',
		path: `${ADMIN_ROOT}/delivery/domains`,
		titleKey: label('sendingDomains'),
		icon: GlobeIcon,
		area: 'delivery',
		wide: true,
	},
	{
		id: 'transport',
		path: `${ADMIN_ROOT}/delivery/transport`,
		titleKey: label('deliveryProvider'),
		icon: TruckIcon,
		area: 'delivery',
	},
	{
		id: 'deliverability',
		path: `${ADMIN_ROOT}/delivery/deliverability`,
		titleKey: label('deliverability'),
		icon: ShieldCheckIcon,
		area: 'delivery',
	},
	{
		// Who sends as each sending domain, from the DMARC aggregate reports
		// receivers mail to Owlat's report address.
		id: 'dmarcReports',
		path: `${ADMIN_ROOT}/delivery/dmarc`,
		titleKey: label('dmarcReports'),
		icon: FileSearchIcon,
		area: 'delivery',
	},
	{
		id: 'webhooks',
		path: `${ADMIN_ROOT}/delivery/webhooks`,
		titleKey: label('webhooks'),
		icon: WebhookIcon,
		area: 'delivery',
	},
	{
		id: 'providerRouting',
		path: `${ADMIN_ROOT}/delivery/provider-routing`,
		titleKey: label('providerRouting'),
		icon: RouteIcon,
		area: 'delivery',
	},
	// Received mail the pipeline held back or could not process. These used to
	// live under the team inbox, where the people who can act on them would
	// never look; here they carry a badge when something is waiting.
	{
		id: 'quarantine',
		path: `${ADMIN_ROOT}/delivery/quarantine`,
		titleKey: label('quarantine'),
		icon: ShieldWarningIcon,
		area: 'delivery',
		gate: flag('inbox'),
		attention: 'quarantined',
	},
	{
		id: 'failed',
		path: `${ADMIN_ROOT}/delivery/failed`,
		titleKey: label('failedMessages'),
		icon: TriangleWarningIcon,
		area: 'delivery',
		gate: flag('inbox'),
		attention: 'failed',
	},
	{
		id: 'activity',
		path: `${ADMIN_ROOT}/delivery/activity`,
		titleKey: label('activity'),
		icon: BroadcastIcon,
		area: 'delivery',
		gate: flag('inbox'),
	},
	{
		id: 'migrate',
		path: `${ADMIN_ROOT}/delivery/migrate`,
		titleKey: label('migrateFromMailchimp'),
		icon: DownloadIcon,
		area: 'delivery',
	},
	{
		// One rail entry for the four ramp pages; the page itself forwards to
		// the first of them, and the layout renders all four as tabs.
		//
		// Listed only once the ramp has taken over a cell. The gate hides the
		// rail and palette rows (children inherit it), not the routes: a docs
		// link still lands on tabs and an empty state that says how to start.
		// Deliverability and the migration guide link to Controls directly.
		id: 'advanced',
		path: `${ADMIN_ROOT}/delivery/advanced`,
		titleKey: label('advanced'),
		icon: Slider1Icon,
		area: 'delivery',
		gate: rampStarted,
		tabs: true,
	},
	{
		id: 'rampControls',
		path: `${ADMIN_ROOT}/delivery/advanced/controls`,
		titleKey: label('controls'),
		icon: Slider1Icon,
		area: 'delivery',
		hidden: true,
		parent: 'advanced',
	},
	{
		id: 'cells',
		path: `${ADMIN_ROOT}/delivery/advanced/cells`,
		titleKey: label('cells'),
		icon: GridAltIcon,
		area: 'delivery',
		hidden: true,
		parent: 'advanced',
		wide: true,
	},
	{
		id: 'independence',
		path: `${ADMIN_ROOT}/delivery/advanced/independence`,
		titleKey: label('independence'),
		icon: PlugIcon,
		area: 'delivery',
		hidden: true,
		parent: 'advanced',
	},
	{
		id: 'measurement',
		path: `${ADMIN_ROOT}/delivery/advanced/measurement`,
		titleKey: label('measurement'),
		icon: TargetIcon,
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
		icon: SparklesIcon,
		area: 'ai',
	},
	{
		// Gated on `ai`, not `ai.agent`: the page's "Off" choice turns the agent
		// off, and the same page is where it gets turned back on. The old agent
		// and autonomy URLs are redirect stubs into this page.
		id: 'aiReplies',
		path: `${ADMIN_ROOT}/instance/ai-replies`,
		titleKey: label('aiReplies'),
		icon: RobotIcon,
		area: 'ai',
		gate: flag('ai'),
	},
	{
		id: 'agentHealth',
		path: `${ADMIN_ROOT}/instance/agent-health`,
		titleKey: label('agentHealth'),
		icon: HeartPulseIcon,
		area: 'ai',
		gate: flag('ai.agent'),
	},

	// ── Features ─────────────────────────────────────────────────────────────
	{
		id: 'features',
		path: `${ADMIN_ROOT}/instance/features`,
		titleKey: label('features'),
		icon: ToggleRightIcon,
		area: 'features',
	},
	{
		// The operating-mode picker. It sets feature flags in bulk, so it hangs
		// off Features rather than holding a rail row of its own.
		id: 'instance',
		path: `${ADMIN_ROOT}/instance`,
		titleKey: label('instance'),
		icon: ServerIcon,
		area: 'features',
		hidden: true,
		parent: 'features',
	},
	{
		id: 'channels',
		path: `${ADMIN_ROOT}/instance/channels`,
		titleKey: label('channels'),
		icon: BroadcastIcon,
		area: 'features',
		wide: true,
	},
	{
		id: 'forms',
		path: `${ADMIN_ROOT}/instance/forms`,
		titleKey: label('forms'),
		icon: FileTextIcon,
		area: 'features',
	},
	{
		id: 'properties',
		path: `${ADMIN_ROOT}/instance/properties`,
		titleKey: label('contactProperties'),
		icon: TagsIcon,
		area: 'features',
	},
	{
		id: 'brandKit',
		path: `${ADMIN_ROOT}/instance/brand-kit`,
		titleKey: label('brandKit'),
		icon: PaletteIcon,
		area: 'features',
		wide: true,
	},
	{
		id: 'sealedMail',
		path: `${ADMIN_ROOT}/instance/sealed-mail`,
		titleKey: label('sealedMail'),
		icon: LockIcon,
		area: 'features',
		gate: flag('sealedMail'),
	},
	{
		id: 'plugins',
		path: `${ADMIN_ROOT}/instance/plugins`,
		titleKey: label('plugins'),
		icon: PuzzleIcon,
		area: 'features',
		gate: withPlugins,
	},

	// ── System ───────────────────────────────────────────────────────────────
	{
		id: 'instanceGeneral',
		path: `${ADMIN_ROOT}/instance/general`,
		titleKey: label('general'),
		icon: Building2Icon,
		area: 'system',
	},
	{
		id: 'desktopUpdates',
		path: `${ADMIN_ROOT}/instance/desktop-updates`,
		titleKey: label('desktopUpdates'),
		icon: MonitorIcon,
		area: 'system',
	},
	{
		id: 'system',
		path: `${ADMIN_ROOT}/system`,
		titleKey: label('systemAndUpdates'),
		icon: CpuIcon,
		area: 'system',
		gate: platformOnly,
	},
	{
		id: 'backups',
		path: `${ADMIN_ROOT}/backups`,
		titleKey: label('backups'),
		icon: DatabaseIcon,
		area: 'system',
		gate: platformOnly,
	},
	{
		id: 'operator',
		path: `${ADMIN_ROOT}/operator`,
		titleKey: label('operatorConsole'),
		icon: ShieldWarningIcon,
		area: 'system',
		gate: platformOnly,
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

/** The entry's own gate, ignoring its parent's. Pure. */
export function passesOwnGate(entry: AdminEntry, env: AdminEnvironment): boolean {
	return !entry.gate || entry.gate(env);
}

/**
 * Whether `env` offers this entry: its own gate, plus its parent's for a hidden
 * child, so a gated-off group takes its tabs out of the palette too. Pure.
 */
export function isAdminEntryReachable(entry: AdminEntry, env: AdminEnvironment): boolean {
	if (!passesOwnGate(entry, env)) return false;
	const parent = entry.parent ? adminEntryById(entry.parent) : undefined;
	return !parent || passesOwnGate(parent, env);
}

/** The entries this environment may reach, hidden ones included, in registry order. Pure. */
export function reachableAdminEntries(env: AdminEnvironment): AdminEntry[] {
	return ADMIN_REGISTRY.filter((candidate) => isAdminEntryReachable(candidate, env));
}
