/**
 * Breadcrumb route tables for the dashboard IA.
 *
 * Exact paths live in `routeConfigs` here; dynamic routes (detail/edit pages)
 * match via `patternConfigs` in `breadcrumbPatterns.ts`. `useBreadcrumbs`
 * consumes both — the tables live outside the composable so it stays
 * logic-only, and the coverage-parity test in
 * `composables/__tests__/useBreadcrumbs.test.ts` guards the tables as data.
 *
 * The settings trails are not written out here: My settings is derived from
 * `lib/settingsRegistry` and Workspace from `lib/adminSettingsRegistry`, the
 * declarations the Settings sidebar and the command palette also read.
 */
import {
	ADMIN_REGISTRY,
	ADMIN_ROOT,
	adminAreaLead,
	adminEntryById,
	type AdminEntry,
} from './adminSettingsRegistry';
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
const MARKETING = 'shared.breadcrumbRoutes.sections.marketing';
const MARKETING_HREF = '/dashboard/marketing';

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

/**
 * The Workspace trails, projected out of the admin registry: "Workspace", then
 * the page's group (or, for a page that hangs off another one, that page), then
 * the page. The words are the rail's own, so the crumb and the nav cannot print
 * two names for one page. A group crumb that would repeat the page (the group's
 * lead page) is left out.
 */
function adminRouteConfigs(): Record<string, RouteConfig> {
	const section = 'shared.breadcrumbRoutes.sections.workspace';
	const configFor = (entry: AdminEntry): RouteConfig => {
		if (entry.path === ADMIN_ROOT) return { section, sectionHref: ADMIN_ROOT };
		const parent = entry.parent ? adminEntryById(entry.parent) : undefined;
		const group = parent ?? adminAreaLead(entry.area);
		const subsection =
			parent !== undefined
				? { subsection: parent.titleKey, subsectionHref: parent.path }
				: group && group.path !== entry.path
					? {
							subsection: `shell.admin.areas.${entry.area}`,
							subsectionHref: group.path,
						}
					: {};
		return { section, sectionHref: ADMIN_ROOT, ...subsection, page: entry.titleKey };
	};
	return Object.fromEntries(ADMIN_REGISTRY.map((entry) => [entry.path, configFor(entry)]));
}

/** One section crumb for every mailbox page; each page adds its own name. */
function postboxPageConfigs(pages: Record<string, string>): Record<string, RouteConfig> {
	return Object.fromEntries(
		Object.entries(pages).map(([path, page]) => [
			path,
			{
				section: 'shared.dashboardNavigation.sections.postbox',
				sectionHref: '/dashboard/postbox/inbox',
				page,
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

	// The mailbox's own pages. Same section crumb as its folders and messages
	// (`breadcrumbPatterns.ts`), so the area has one name wherever you are in it
	// instead of "Inboxes" on a folder and a URL slug ("Postbox") on search.
	...postboxPageConfigs({
		'/dashboard/postbox/search': 'shared.breadcrumbRoutes.pages.mailSearch',
		'/dashboard/postbox/contacts': 'shared.breadcrumbRoutes.pages.contacts',
		'/dashboard/postbox/files': 'shared.breadcrumbRoutes.pages.files',
		'/dashboard/postbox/subscriptions': 'shared.breadcrumbRoutes.pages.subscriptions',
		'/dashboard/postbox/migrate': 'shared.breadcrumbRoutes.pages.importMail',
	}),

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

	// Workspace settings (`/dashboard/admin/**`) are DERIVED — see
	// `adminRouteConfigs` below.

	// Preferences section (personal, per-user settings) is DERIVED — see
	// `preferencesRouteConfigs` below.

	...preferencesRouteConfigs(),
	...adminRouteConfigs(),
};
