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

	// Send section
	'/dashboard/send': {
		section: 'shared.breadcrumbRoutes.sections.send',
		sectionHref: '/dashboard/send',
		page: 'shared.breadcrumbRoutes.pages.templatesAndBlocks',
	},
	'/dashboard/send/marketing': {
		section: 'shared.breadcrumbRoutes.sections.send',
		sectionHref: '/dashboard/send',
		page: 'shared.breadcrumbRoutes.pages.marketing',
	},
	'/dashboard/send/transactional': {
		section: 'shared.breadcrumbRoutes.sections.send',
		sectionHref: '/dashboard/send',
		page: 'shared.breadcrumbRoutes.pages.transactional',
	},
	'/dashboard/send/blocks': {
		section: 'shared.breadcrumbRoutes.sections.send',
		sectionHref: '/dashboard/send',
		page: 'shared.breadcrumbRoutes.pages.blocks',
	},
	'/dashboard/send/media': {
		section: 'shared.breadcrumbRoutes.sections.send',
		sectionHref: '/dashboard/send',
		page: 'shared.breadcrumbRoutes.pages.media',
	},

	// Marketing workspace
	'/dashboard/marketing': {
		section: 'shared.breadcrumbRoutes.sections.marketing',
		sectionHref: '/dashboard/marketing',
		page: 'shared.breadcrumbRoutes.pages.overview',
	},

	// Campaigns section
	// Filed under Send, matching the sidebar — the section crumb was
	// `campaigns` too, so the index route read "Campaigns > Campaigns".
	'/dashboard/campaigns': {
		section: 'shared.breadcrumbRoutes.sections.send',
		sectionHref: '/dashboard/send',
		page: 'shared.breadcrumbRoutes.pages.campaigns',
	},
	'/dashboard/campaigns/new': {
		section: 'shared.breadcrumbRoutes.sections.campaigns',
		sectionHref: '/dashboard/campaigns',
		page: 'shared.breadcrumbRoutes.pages.newCampaign',
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

	// Automations section
	'/dashboard/automations': {
		section: 'shared.breadcrumbRoutes.sections.automations',
		sectionHref: '/dashboard/automations',
	},

	...preferencesRouteConfigs(),
	...adminRouteConfigs(),
};
