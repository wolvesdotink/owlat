/**
 * Pattern-matched breadcrumb configs for dynamic dashboard routes
 * (detail/edit pages with ids in the path). Exact paths live in
 * `breadcrumbRoutes.ts`; `useBreadcrumbs` tries those first, then these.
 *
 * Every label is an i18n KEY (the crumb renderer translates it). The SECTION
 * keys are the ones `breadcrumbRoutes.ts` already defines, so a section reads
 * the same word whichever table matched the path.
 */
import {
	MARKETING_AUTOMATIONS,
	MARKETING_CAMPAIGNS,
	MARKETING_TEMPLATES,
	type RouteConfig,
} from '~/lib/breadcrumbRoutes';

export interface PatternConfig {
	pattern: RegExp;
	getConfig: (match: RegExpMatchArray) => RouteConfig;
}

/**
 * Postbox system folders, by the `[folder]` route param. A custom folder is
 * addressed by its `mailFolders` id instead and has no key here — the trail then
 * skips the folder crumb rather than printing a raw document id.
 *
 * Reuses the reader's own folder-role catalog so the crumb reads the same word
 * as the folder rail the message was opened from.
 */
const POSTBOX_FOLDER_ROLE_KEYS: Record<string, string> = {
	inbox: 'components.postbox.postboxLayout.folderRoles.inbox',
	drafts: 'components.postbox.postboxLayout.folderRoles.drafts',
	sent: 'components.postbox.postboxLayout.folderRoles.sent',
	archive: 'components.postbox.postboxLayout.folderRoles.archive',
	spam: 'components.postbox.postboxLayout.folderRoles.spam',
	trash: 'components.postbox.postboxLayout.folderRoles.trash',
	snoozed: 'components.postbox.postboxLayout.folderRoles.snoozed',
};

/** `inbox|drafts|sent|…` — the folder-list pattern matches these slugs ONLY, so
 * the section's other one-segment pages (Contacts, Files, Search, …) keep their
 * own trails instead of being read as folders. */
const POSTBOX_FOLDER_ROLE_PATTERN = Object.keys(POSTBOX_FOLDER_ROLE_KEYS).join('|');

export const patternConfigs: PatternConfig[] = [
	/**
	 * A system folder's message list: /dashboard/postbox/inbox, /…/sent, …
	 *
	 * Without an entry here the slug fallback took over and the list view
	 * disagreed with the message view it opens into — "Dashboard > Postbox >
	 * Inbox" (a redundant root crumb beside the home icon, and an untranslated
	 * capitalized URL slug) against the reader's own "Mail > Inbox > Message".
	 * Same rule as below: the trail must not say "Postbox" beside a sidebar that
	 * says "Mail".
	 */
	{
		pattern: new RegExp(`^/dashboard/postbox/(${POSTBOX_FOLDER_ROLE_PATTERN})$`),
		getConfig: (match) => {
			const folderKey = POSTBOX_FOLDER_ROLE_KEYS[match[1] ?? ''];
			return {
				section: 'shared.dashboardNavigation.sections.postbox',
				sectionHref: '/dashboard/postbox/inbox',
				...(folderKey ? { page: folderKey } : {}),
			};
		},
	},
	/**
	 * An open message: /dashboard/postbox/<folder>/<messageId>.
	 *
	 * Without an entry here the slug fallback took over and printed the raw
	 * `mailMessages` id as the last crumb ("Mm_…"). The page crumb is a fixed
	 * "Message" label: the subject is not on the route, and a trail is not the
	 * place to wait on a query.
	 *
	 * `(?!label\/)` keeps /dashboard/postbox/label/<labelId> — a folder-shaped
	 * two-segment route that is NOT a message — on its own trail.
	 */
	{
		pattern: /^\/dashboard\/postbox\/(?!label\/)([^/]+)\/([^/]+)$/,
		getConfig: (match) => {
			const folderKey = POSTBOX_FOLDER_ROLE_KEYS[match[1] ?? ''];
			return {
				// The sidebar's own key: the trail must not say "Postbox" beside a
				// sidebar that says "Mail" (same rule as the member Audience remap).
				section: 'shared.dashboardNavigation.sections.postbox',
				sectionHref: '/dashboard/postbox/inbox',
				...(folderKey
					? { subsection: folderKey, subsectionHref: `/dashboard/postbox/${match[1]}` }
					: {}),
				page: 'shared.breadcrumbPatterns.pages.message',
			};
		},
	},
	// A label's message list — same raw-id problem, same fixed-label answer.
	{
		pattern: /^\/dashboard\/postbox\/label\/([^/]+)$/,
		getConfig: () => ({
			section: 'shared.dashboardNavigation.sections.postbox',
			sectionHref: '/dashboard/postbox/inbox',
			page: 'shared.breadcrumbPatterns.pages.label',
		}),
	},
	// Email template edit
	{
		pattern: /^\/dashboard\/send\/emails\/([^/]+)\/edit$/,
		getConfig: () => ({
			...MARKETING_TEMPLATES,
			page: 'shared.breadcrumbPatterns.pages.editTemplate',
		}),
	},
	// Transactional template edit
	{
		pattern: /^\/dashboard\/send\/transactional\/([^/]+)\/edit$/,
		getConfig: () => ({
			...MARKETING_TEMPLATES,
			page: 'shared.breadcrumbPatterns.pages.editTemplate',
		}),
	},
	// Campaign edit
	{
		pattern: /^\/dashboard\/campaigns\/([^/]+)\/edit$/,
		getConfig: () => ({
			...MARKETING_CAMPAIGNS,
			page: 'shared.breadcrumbPatterns.pages.editCampaign',
		}),
	},
	// Campaign report
	{
		pattern: /^\/dashboard\/campaigns\/([^/]+)\/report$/,
		getConfig: () => ({
			...MARKETING_CAMPAIGNS,
			page: 'shared.breadcrumbPatterns.pages.campaignReport',
		}),
	},
	// Automation edit
	{
		pattern: /^\/dashboard\/automations\/([^/]+)\/edit$/,
		getConfig: () => ({
			...MARKETING_AUTOMATIONS,
			page: 'shared.breadcrumbPatterns.pages.editAutomation',
		}),
	},
	// Automation new
	{
		pattern: /^\/dashboard\/automations\/new$/,
		getConfig: () => ({
			...MARKETING_AUTOMATIONS,
			page: 'shared.breadcrumbPatterns.pages.newAutomation',
		}),
	},
	// Contact detail
	{
		pattern: /^\/dashboard\/audience\/contacts\/([^/]+)$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.audience',
			sectionHref: '/dashboard/audience',
			subsection: 'shared.breadcrumbPatterns.subsections.contacts',
			subsectionHref: '/dashboard/audience/contacts',
			page: 'shared.breadcrumbPatterns.pages.contactDetails',
		}),
	},
	// Topic detail
	{
		pattern: /^\/dashboard\/audience\/topics\/([^/]+)$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.audience',
			sectionHref: '/dashboard/audience',
			subsection: 'shared.breadcrumbPatterns.subsections.topics',
			subsectionHref: '/dashboard/audience/topics',
			page: 'shared.breadcrumbPatterns.pages.topicDetails',
		}),
	},
	// Contact in topic detail
	{
		pattern: /^\/dashboard\/audience\/topics\/([^/]+)\/contacts\/([^/]+)$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.audience',
			sectionHref: '/dashboard/audience',
			subsection: 'shared.breadcrumbPatterns.subsections.topics',
			subsectionHref: '/dashboard/audience/topics',
			page: 'shared.breadcrumbPatterns.pages.contactInTopic',
		}),
	},
	// Segment detail
	{
		pattern: /^\/dashboard\/audience\/segments\/([^/]+)$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.audience',
			sectionHref: '/dashboard/audience',
			subsection: 'shared.breadcrumbPatterns.subsections.segments',
			subsectionHref: '/dashboard/audience/segments',
			page: 'shared.breadcrumbPatterns.pages.segmentDetails',
		}),
	},
	// Per-plugin settings panel
	{
		pattern: /^\/dashboard\/admin\/instance\/plugins\/([^/]+)$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.administration',
			sectionHref: '/dashboard/admin',
			subsection: 'shared.breadcrumbPatterns.subsections.plugins',
			subsectionHref: '/dashboard/admin/instance/plugins',
			page: 'shared.breadcrumbPatterns.pages.pluginSettings',
		}),
	},
	// Team inbox members
	{
		pattern: /^\/dashboard\/preferences\/members\/([^/]+)$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.preferences',
			sectionHref: '/dashboard/preferences',
			page: 'shared.breadcrumbPatterns.pages.teamInboxMembers',
		}),
	},
	/**
	 * Every other page inside a Marketing subtree (an automation's detail, a
	 * campaign send, a template's settings or translations) keeps the workspace
	 * trail up to its list. Without these the slug fallback printed a bare
	 * "Automations" or "Send › Emails", with no Marketing crumb at all. Last on
	 * purpose: the specific patterns above win.
	 */
	{ pattern: /^\/dashboard\/campaigns\/.+/, getConfig: () => ({ ...MARKETING_CAMPAIGNS }) },
	{ pattern: /^\/dashboard\/automations\/.+/, getConfig: () => ({ ...MARKETING_AUTOMATIONS }) },
	{ pattern: /^\/dashboard\/send\/.+/, getConfig: () => ({ ...MARKETING_TEMPLATES }) },
];
