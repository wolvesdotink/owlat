/**
 * Breadcrumb route tables for the dashboard IA.
 *
 * Exact paths live in `routeConfigs` here; dynamic routes (detail/edit pages)
 * match via `patternConfigs` in `breadcrumbPatterns.ts`. `useBreadcrumbs`
 * consumes both — the tables live outside the composable so it stays
 * logic-only, and the coverage-parity test in
 * `composables/__tests__/useBreadcrumbs.test.ts` guards the tables as data.
 */

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

// Define route configurations for the new navigation structure
export const routeConfigs: Record<string, RouteConfig> = {
	// Dashboard
	'/dashboard': {
		section: 'shared.breadcrumbRoutes.sections.dashboard',
		sectionHref: '/dashboard',
	},

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

	// Campaigns section
	'/dashboard/campaigns': {
		section: 'shared.breadcrumbRoutes.sections.campaigns',
		sectionHref: '/dashboard/campaigns',
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

	// Preferences section (personal, per-user settings)
	'/dashboard/preferences': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
	},
	'/dashboard/preferences/account': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.account',
	},
	'/dashboard/preferences/filters': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.filters',
	},
	'/dashboard/preferences/signatures': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.signatures',
	},
	'/dashboard/preferences/snippets': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.snippets',
	},
	'/dashboard/preferences/vacation': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.vacationAutoReply',
	},
	'/dashboard/preferences/forwarding': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.forwarding',
	},
	'/dashboard/preferences/aliases': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.aliases',
	},
	'/dashboard/preferences/app-passwords': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.appPasswords',
	},
	'/dashboard/preferences/writing-voice': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.writingVoice',
	},
	'/dashboard/preferences/external-account': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.connectedMailboxes',
	},
	'/dashboard/preferences/add-account': {
		section: 'shared.breadcrumbRoutes.sections.preferences',
		sectionHref: '/dashboard/preferences',
		page: 'shared.breadcrumbRoutes.pages.addMailAccount',
	},

	// Automations section
	'/dashboard/automations': {
		section: 'shared.breadcrumbRoutes.sections.automations',
		sectionHref: '/dashboard/automations',
	},
};
