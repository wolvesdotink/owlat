/**
 * Pattern-matched breadcrumb configs for dynamic dashboard routes
 * (detail/edit pages with ids in the path). Exact paths live in
 * `breadcrumbRoutes.ts`; `useBreadcrumbs` tries those first, then these.
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
			section: 'Send',
			sectionHref: '/dashboard/send',
			subsection: 'Marketing',
			subsectionHref: '/dashboard/send/marketing',
			page: 'Edit Template',
		}),
	},
	// Transactional template edit
	{
		pattern: /^\/dashboard\/send\/transactional\/([^/]+)\/edit$/,
		getConfig: () => ({
			section: 'Send',
			sectionHref: '/dashboard/send',
			subsection: 'Transactional',
			subsectionHref: '/dashboard/send/transactional',
			page: 'Edit Template',
		}),
	},
	// Campaign edit
	{
		pattern: /^\/dashboard\/campaigns\/([^/]+)\/edit$/,
		getConfig: () => ({
			section: 'Campaigns',
			sectionHref: '/dashboard/campaigns',
			page: 'Edit Campaign',
		}),
	},
	// Campaign report
	{
		pattern: /^\/dashboard\/campaigns\/([^/]+)\/report$/,
		getConfig: () => ({
			section: 'Campaigns',
			sectionHref: '/dashboard/campaigns',
			page: 'Campaign Report',
		}),
	},
	// Automation edit
	{
		pattern: /^\/dashboard\/automations\/([^/]+)\/edit$/,
		getConfig: () => ({
			section: 'Automations',
			sectionHref: '/dashboard/automations',
			page: 'Edit Automation',
		}),
	},
	// Automation new
	{
		pattern: /^\/dashboard\/automations\/new$/,
		getConfig: () => ({
			section: 'Automations',
			sectionHref: '/dashboard/automations',
			page: 'New Automation',
		}),
	},
	// Contact detail
	{
		pattern: /^\/dashboard\/audience\/contacts\/([^/]+)$/,
		getConfig: () => ({
			section: 'Audience',
			sectionHref: '/dashboard/audience',
			subsection: 'Contacts',
			subsectionHref: '/dashboard/audience/contacts',
			page: 'Contact Details',
		}),
	},
	// Topic detail
	{
		pattern: /^\/dashboard\/audience\/topics\/([^/]+)$/,
		getConfig: () => ({
			section: 'Audience',
			sectionHref: '/dashboard/audience',
			subsection: 'Topics',
			subsectionHref: '/dashboard/audience/topics',
			page: 'Topic Details',
		}),
	},
	// Contact in topic detail
	{
		pattern: /^\/dashboard\/audience\/topics\/([^/]+)\/contacts\/([^/]+)$/,
		getConfig: () => ({
			section: 'Audience',
			sectionHref: '/dashboard/audience',
			subsection: 'Topics',
			subsectionHref: '/dashboard/audience/topics',
			page: 'Contact in Topic',
		}),
	},
	// Segment detail
	{
		pattern: /^\/dashboard\/audience\/segments\/([^/]+)$/,
		getConfig: () => ({
			section: 'Audience',
			sectionHref: '/dashboard/audience',
			subsection: 'Segments',
			subsectionHref: '/dashboard/audience/segments',
			page: 'Segment Details',
		}),
	},
	// Per-plugin settings panel
	{
		pattern: /^\/dashboard\/admin\/instance\/plugins\/([^/]+)$/,
		getConfig: () => ({
			section: 'Administration',
			sectionHref: '/dashboard/admin',
			subsection: 'Plugins',
			subsectionHref: '/dashboard/admin/instance/plugins',
			page: 'Plugin settings',
		}),
	},
	// Team inbox members
	{
		pattern: /^\/dashboard\/preferences\/members\/([^/]+)$/,
		getConfig: () => ({
			section: 'Preferences',
			sectionHref: '/dashboard/preferences',
			page: 'Team inbox members',
		}),
	},
];
