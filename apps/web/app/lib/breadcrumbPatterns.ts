/**
 * Pattern-matched breadcrumb configs for dynamic dashboard routes
 * (detail/edit pages with ids in the path). Exact paths live in
 * `breadcrumbRoutes.ts`; `useBreadcrumbs` tries those first, then these.
 *
 * Every label is an i18n KEY (the crumb renderer translates it). The SECTION
 * keys are the ones `breadcrumbRoutes.ts` already defines, so a section reads
 * the same word whichever table matched the path.
 */
import type { RouteConfig } from '~/lib/breadcrumbRoutes';

export interface PatternConfig {
	pattern: RegExp;
	getConfig: (match: RegExpMatchArray) => RouteConfig;
}

export const patternConfigs: PatternConfig[] = [
	// Email template edit
	{
		pattern: /^\/dashboard\/send\/emails\/([^/]+)\/edit$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.send',
			sectionHref: '/dashboard/send',
			subsection: 'shared.breadcrumbPatterns.subsections.marketing',
			subsectionHref: '/dashboard/send/marketing',
			page: 'shared.breadcrumbPatterns.pages.editTemplate',
		}),
	},
	// Transactional template edit
	{
		pattern: /^\/dashboard\/send\/transactional\/([^/]+)\/edit$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.send',
			sectionHref: '/dashboard/send',
			subsection: 'shared.breadcrumbPatterns.subsections.transactional',
			subsectionHref: '/dashboard/send/transactional',
			page: 'shared.breadcrumbPatterns.pages.editTemplate',
		}),
	},
	// Campaign edit
	{
		pattern: /^\/dashboard\/campaigns\/([^/]+)\/edit$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.campaigns',
			sectionHref: '/dashboard/campaigns',
			page: 'shared.breadcrumbPatterns.pages.editCampaign',
		}),
	},
	// Campaign report
	{
		pattern: /^\/dashboard\/campaigns\/([^/]+)\/report$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.campaigns',
			sectionHref: '/dashboard/campaigns',
			page: 'shared.breadcrumbPatterns.pages.campaignReport',
		}),
	},
	// Automation edit
	{
		pattern: /^\/dashboard\/automations\/([^/]+)\/edit$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.automations',
			sectionHref: '/dashboard/automations',
			page: 'shared.breadcrumbPatterns.pages.editAutomation',
		}),
	},
	// Automation new
	{
		pattern: /^\/dashboard\/automations\/new$/,
		getConfig: () => ({
			section: 'shared.breadcrumbRoutes.sections.automations',
			sectionHref: '/dashboard/automations',
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
];
