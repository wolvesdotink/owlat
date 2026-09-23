/**
 * Breadcrumb route tables for the dashboard IA.
 *
 * Exact paths live in `routeConfigs` here; dynamic routes (detail/edit pages)
 * match via `patternConfigs` in `breadcrumbPatterns.ts`. `useBreadcrumbs`
 * consumes both — the tables live outside the composable so it stays
 * logic-only, and the coverage-parity test in
 * `composables/__tests__/useBreadcrumbs.test.ts` guards the tables as data.
 *
 * The Preferences trails are not written out here: they are derived from
 * `lib/settingsRegistry`, the one declaration the hub, the left nav and the
 * command palette also read.
 */
import { SETTINGS_REGISTRY, SETTINGS_ROOT } from './settingsRegistry';

/**
 * Route configuration mapping paths to breadcrumb structure.
 *
 * `section`, `subsection` and `page` are i18n KEYS, not words: these tables are
 * module scope and cannot call `useI18n`, so the crumb renderer is what turns a
 * key into a label (see the UI-localization guide).
 */
export interface RouteConfig {
	section: string;
	sectionHref: string;
	subsection?: string;
	subsectionHref?: string;
	page?: string;
}

/** The Marketing workspace crumb — the word the sidebar's switch shows. */
export const MARKETING = 'shared.breadcrumbRoutes.sections.marketing';
export const MARKETING_HREF = '/dashboard/marketing';

/** "Marketing › Campaigns", the parent of every campaign page. */
export const MARKETING_CAMPAIGNS = {
	section: MARKETING,
	sectionHref: MARKETING_HREF,
	subsection: 'shared.breadcrumbRoutes.pages.campaigns',
	subsectionHref: '/dashboard/campaigns',
} as const;

/** "Marketing › Automations", the parent of every automation page. */
export const MARKETING_AUTOMATIONS = {
	section: MARKETING,
	sectionHref: MARKETING_HREF,
	subsection: 'shared.breadcrumbRoutes.pages.automations',
	subsectionHref: '/dashboard/automations',
} as const;

/** "Marketing › Templates", the parent of every template page. */
export const MARKETING_TEMPLATES = {
	section: MARKETING,
	sectionHref: MARKETING_HREF,
	subsection: 'shared.breadcrumbRoutes.pages.templates',
	subsectionHref: '/dashboard/send',
} as const;

/**
 * The Preferences trails, projected out of the settings registry.
 *
 * Preferences pages used to be restated here by hand, so a new page had to be
 * remembered in the sidebar table, in this one, and in the hub's link grid; the
 * three had already drifted. One declaration means a registry entry gets its
 * crumb — with the SAME words the left nav and the hub print for it — for free.
 * Gates are deliberately ignored: a crumb describes where you are, and if a
 * gate let you reach the page the trail must still name it.
 */
function preferencesRouteConfigs(): Record<string, RouteConfig> {
	return Object.fromEntries(
		SETTINGS_REGISTRY.map((entry) => [
			entry.path,
			{
				section: 'shared.breadcrumbRoutes.sections.preferences',
				sectionHref: SETTINGS_ROOT,
				// The hub is the section crumb itself — a second "Overview" crumb
				// under it would just repeat the link you are standing on.
				...(entry.path === SETTINGS_ROOT ? {} : { page: entry.titleKey }),
			},
		])
	);
}

// Define route configurations for the new navigation structure
export const routeConfigs: Record<string, RouteConfig> = {
	// Dashboard
	'/dashboard': {
		section: 'shared.breadcrumbRoutes.sections.dashboard',
		sectionHref: '/dashboard',
	},
	'/dashboard/answer': {
		section: 'shared.breadcrumbRoutes.sections.answer',
		sectionHref: '/dashboard/answer',
	},
	'/dashboard/inboxes': {
		section: 'shared.breadcrumbRoutes.sections.inboxes',
		sectionHref: '/dashboard/inboxes',
	},
	'/dashboard/inbox': {
		section: 'shared.breadcrumbRoutes.sections.teamInbox',
		sectionHref: '/dashboard/inbox',
	},

	// Marketing workspace. Campaigns, automations and templates are filed under
	// it, matching the sidebar's Marketing switch — the trail used to say "Send",
	// a section the sidebar no longer has.
	'/dashboard/marketing': {
		section: MARKETING,
		sectionHref: MARKETING_HREF,
		page: 'shared.breadcrumbRoutes.pages.overview',
	},
	'/dashboard/campaigns': {
		section: MARKETING,
		sectionHref: MARKETING_HREF,
		page: 'shared.breadcrumbRoutes.pages.campaigns',
	},
	'/dashboard/campaigns/new': {
		...MARKETING_CAMPAIGNS,
		page: 'shared.breadcrumbRoutes.pages.newCampaign',
	},
	'/dashboard/automations': {
		section: MARKETING,
		sectionHref: MARKETING_HREF,
		page: 'shared.breadcrumbRoutes.pages.automations',
	},
	'/dashboard/send': {
		section: MARKETING,
		sectionHref: MARKETING_HREF,
		page: 'shared.breadcrumbRoutes.pages.templates',
	},
	'/dashboard/send/marketing': {
		...MARKETING_TEMPLATES,
		page: 'shared.breadcrumbRoutes.pages.marketing',
	},
	'/dashboard/send/transactional': {
		...MARKETING_TEMPLATES,
		page: 'shared.breadcrumbRoutes.pages.transactional',
	},
	'/dashboard/send/blocks': {
		...MARKETING_TEMPLATES,
		page: 'shared.breadcrumbRoutes.pages.blocks',
	},
	'/dashboard/send/media': {
		...MARKETING_TEMPLATES,
		page: 'shared.breadcrumbRoutes.pages.media',
	},

	// Audience section
	'/dashboard/audience': {
		section: 'shared.breadcrumbRoutes.sections.audience',
		sectionHref: '/dashboard/audience',
		page: 'shared.breadcrumbRoutes.pages.overview',
	},
	'/dashboard/audience/contacts': {
		section: 'shared.breadcrumbRoutes.sections.audience',
		sectionHref: '/dashboard/audience',
		page: 'shared.breadcrumbRoutes.pages.contacts',
	},
	'/dashboard/audience/topics': {
		section: 'shared.breadcrumbRoutes.sections.audience',
		sectionHref: '/dashboard/audience',
		page: 'shared.breadcrumbRoutes.pages.topics',
	},
	'/dashboard/audience/segments': {
		section: 'shared.breadcrumbRoutes.sections.audience',
		sectionHref: '/dashboard/audience',
		page: 'shared.breadcrumbRoutes.pages.segments',
	},
	'/dashboard/audience/suppressions': {
		section: 'shared.breadcrumbRoutes.sections.audience',
		sectionHref: '/dashboard/audience',
		page: 'shared.breadcrumbRoutes.pages.suppressions',
	},

	// Administration section
	'/dashboard/admin': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		page: 'shared.breadcrumbRoutes.pages.overview',
	},
	'/dashboard/admin/backups': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		page: 'shared.breadcrumbRoutes.pages.backups',
	},
	'/dashboard/admin/operator': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		page: 'shared.breadcrumbRoutes.pages.operatorConsole',
	},
	'/dashboard/admin/system': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		page: 'shared.breadcrumbRoutes.pages.systemAndUpdates',
	},
	'/dashboard/admin/instance': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		page: 'shared.breadcrumbRoutes.pages.instance',
	},
	'/dashboard/admin/instance/general': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.general',
	},
	'/dashboard/admin/instance/features': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.features',
	},
	'/dashboard/admin/instance/desktop-updates': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.desktopUpdates',
	},
	'/dashboard/admin/instance/channels': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.channels',
	},
	'/dashboard/admin/instance/ai-provider': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.aiProvider',
	},
	'/dashboard/admin/instance/agent': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.aiAgent',
	},
	'/dashboard/admin/instance/agent-health': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.agentHealth',
	},
	'/dashboard/admin/instance/autonomy': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.autonomyRules',
	},
	'/dashboard/admin/instance/sealed-mail': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.secureMail',
	},
	'/dashboard/admin/instance/plugins': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.plugins',
	},
	'/dashboard/admin/delivery': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.health',
	},
	'/dashboard/admin/delivery/deliverability': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.deliverability',
	},
	'/dashboard/admin/delivery/advanced/measurement': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.measurement',
	},
	'/dashboard/admin/delivery/advanced/independence': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.independence',
	},
	'/dashboard/admin/delivery/advanced/cells': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.cells',
	},
	'/dashboard/admin/delivery/advanced/controls': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.controls',
	},
	'/dashboard/admin/delivery/transport': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'shared.breadcrumbRoutes.subsections.setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.deliveryProvider',
	},
	'/dashboard/admin/delivery/domains': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'shared.breadcrumbRoutes.subsections.setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.sendingDomains',
	},
	'/dashboard/admin/delivery/migrate': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'shared.breadcrumbRoutes.subsections.setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.migrateFromMailchimp',
	},
	'/dashboard/admin/delivery/provider-routing': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'shared.breadcrumbRoutes.subsections.setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.providerRouting',
	},
	'/dashboard/admin/delivery/webhooks': {
		section: 'shared.breadcrumbRoutes.sections.delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'shared.breadcrumbRoutes.subsections.setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'shared.breadcrumbRoutes.pages.webhooks',
	},
	'/dashboard/admin/team': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		page: 'shared.breadcrumbRoutes.pages.teamAccess',
	},
	'/dashboard/admin/instance/email-theme': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.emailTheme',
	},
	'/dashboard/admin/team/api': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.teamAccess',
		subsectionHref: '/dashboard/admin/team',
		page: 'shared.breadcrumbRoutes.pages.apiKeys',
	},
	'/dashboard/admin/team/api/docs': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.teamAccess',
		subsectionHref: '/dashboard/admin/team',
		page: 'shared.breadcrumbRoutes.pages.apiQuickstart',
	},
	'/dashboard/admin/team/senders': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.teamAccess',
		subsectionHref: '/dashboard/admin/team',
		page: 'shared.breadcrumbRoutes.pages.campaignSenders',
	},
	'/dashboard/admin/team/inboxes': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.teamAccess',
		subsectionHref: '/dashboard/admin/team',
		page: 'shared.breadcrumbRoutes.pages.teamInboxes',
	},
	'/dashboard/admin/team/connected-apps': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.teamAccess',
		subsectionHref: '/dashboard/admin/team',
		page: 'shared.breadcrumbRoutes.pages.connectedApps',
	},
	'/dashboard/admin/instance/forms': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.forms',
	},
	'/dashboard/admin/team/audit': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.teamAccess',
		subsectionHref: '/dashboard/admin/team',
		page: 'shared.breadcrumbRoutes.pages.auditLog',
	},
	'/dashboard/admin/instance/properties': {
		section: 'shared.breadcrumbRoutes.sections.administration',
		sectionHref: '/dashboard/admin',
		subsection: 'shared.breadcrumbRoutes.subsections.instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'shared.breadcrumbRoutes.pages.contactProperties',
	},

	// Preferences section (personal, per-user settings) is DERIVED — see
	// `preferencesRouteConfigs` below.

	...preferencesRouteConfigs(),
};
