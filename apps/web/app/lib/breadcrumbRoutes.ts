/**
 * Breadcrumb route tables for the dashboard IA.
 *
 * Exact paths live in `routeConfigs` here; dynamic routes (detail/edit pages)
 * match via `patternConfigs` in `breadcrumbPatterns.ts`. `useBreadcrumbs`
 * consumes both — the tables live outside the composable so it stays
 * logic-only, and the coverage-parity test in
 * `composables/__tests__/useBreadcrumbs.test.ts` guards the tables as data.
 */

// Route configuration mapping paths to breadcrumb structure
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
		section: 'Dashboard',
		sectionHref: '/dashboard',
	},

	// Send section
	'/dashboard/send': {
		section: 'Send',
		sectionHref: '/dashboard/send',
		page: 'Templates & blocks',
	},
	'/dashboard/send/marketing': {
		section: 'Send',
		sectionHref: '/dashboard/send',
		page: 'Marketing',
	},
	'/dashboard/send/transactional': {
		section: 'Send',
		sectionHref: '/dashboard/send',
		page: 'Transactional',
	},
	'/dashboard/send/blocks': {
		section: 'Send',
		sectionHref: '/dashboard/send',
		page: 'Blocks',
	},
	'/dashboard/send/media': {
		section: 'Send',
		sectionHref: '/dashboard/send',
		page: 'Media',
	},

	// Campaigns section
	'/dashboard/campaigns': {
		section: 'Campaigns',
		sectionHref: '/dashboard/campaigns',
		page: 'Campaigns',
	},
	'/dashboard/campaigns/new': {
		section: 'Campaigns',
		sectionHref: '/dashboard/campaigns',
		page: 'New Campaign',
	},

	// Audience section
	'/dashboard/audience': {
		section: 'Audience',
		sectionHref: '/dashboard/audience',
		page: 'Overview',
	},
	'/dashboard/audience/contacts': {
		section: 'Audience',
		sectionHref: '/dashboard/audience',
		page: 'Contacts',
	},
	'/dashboard/audience/topics': {
		section: 'Audience',
		sectionHref: '/dashboard/audience',
		page: 'Topics',
	},
	'/dashboard/audience/segments': {
		section: 'Audience',
		sectionHref: '/dashboard/audience',
		page: 'Segments',
	},
	'/dashboard/audience/suppressions': {
		section: 'Audience',
		sectionHref: '/dashboard/audience',
		page: 'Suppressions',
	},

	// Administration section
	'/dashboard/admin': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Overview',
	},
	'/dashboard/admin/backups': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Backups',
	},
	'/dashboard/admin/operator': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Operator Console',
	},
	'/dashboard/admin/system': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'System & Updates',
	},
	'/dashboard/admin/instance': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Instance',
	},
	'/dashboard/admin/instance/general': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'General',
	},
	'/dashboard/admin/instance/features': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'Features',
	},
	'/dashboard/admin/instance/channels': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'Channels',
	},
	'/dashboard/admin/instance/ai-provider': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'AI provider',
	},
	'/dashboard/admin/instance/agent': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'AI agent',
	},
	'/dashboard/admin/instance/agent-health': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'Agent health',
	},
	'/dashboard/admin/instance/autonomy': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'Autonomy rules',
	},
	'/dashboard/admin/instance/sealed-mail': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'Secure mail',
	},
	'/dashboard/admin/instance/plugins': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'Plugins',
	},
	'/dashboard/admin/delivery': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'Health',
	},
	'/dashboard/admin/delivery/deliverability': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'Deliverability',
	},
	'/dashboard/admin/delivery/advanced/measurement': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'Measurement',
	},
	'/dashboard/admin/delivery/advanced/independence': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'Independence',
	},
	'/dashboard/admin/delivery/advanced/cells': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'Cells',
	},
	'/dashboard/admin/delivery/advanced/controls': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'Controls',
	},
	'/dashboard/admin/delivery/transport': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'Setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'Delivery provider',
	},
	'/dashboard/admin/delivery/domains': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'Setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'Sending Domains',
	},
	'/dashboard/admin/delivery/migrate': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'Setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'Migrate from Mailchimp',
	},
	'/dashboard/admin/delivery/provider-routing': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'Setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'Provider Routing',
	},
	'/dashboard/admin/delivery/webhooks': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		subsection: 'Setup',
		subsectionHref: '/dashboard/admin/delivery',
		page: 'Webhooks',
	},
	'/dashboard/admin/team': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Team & access',
	},
	'/dashboard/admin/instance/email-theme': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'Email Theme',
	},
	'/dashboard/admin/team/api': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Team & access',
		subsectionHref: '/dashboard/admin/team',
		page: 'API Keys',
	},
	'/dashboard/admin/team/api/docs': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Team & access',
		subsectionHref: '/dashboard/admin/team',
		page: 'API Quickstart',
	},
	'/dashboard/admin/team/senders': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Team & access',
		subsectionHref: '/dashboard/admin/team',
		page: 'Campaign senders',
	},
	'/dashboard/admin/team/inboxes': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Team & access',
		subsectionHref: '/dashboard/admin/team',
		page: 'Team Inboxes',
	},
	'/dashboard/admin/team/connected-apps': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Team & access',
		subsectionHref: '/dashboard/admin/team',
		page: 'Connected apps',
	},
	'/dashboard/admin/instance/forms': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'Forms',
	},
	'/dashboard/admin/team/audit': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Team & access',
		subsectionHref: '/dashboard/admin/team',
		page: 'Audit Log',
	},
	'/dashboard/admin/instance/properties': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		subsection: 'Instance',
		subsectionHref: '/dashboard/admin/instance',
		page: 'Contact properties',
	},

	// Preferences section (personal, per-user settings)
	'/dashboard/preferences': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
	},
	'/dashboard/preferences/account': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Account',
	},
	'/dashboard/preferences/filters': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Filters',
	},
	'/dashboard/preferences/signatures': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Signatures',
	},
	'/dashboard/preferences/snippets': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Snippets',
	},
	'/dashboard/preferences/vacation': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Vacation auto-reply',
	},
	'/dashboard/preferences/forwarding': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Forwarding',
	},
	'/dashboard/preferences/aliases': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Aliases',
	},
	'/dashboard/preferences/app-passwords': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'App passwords',
	},
	'/dashboard/preferences/writing-voice': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Writing voice',
	},
	'/dashboard/preferences/external-account': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Connected mailboxes',
	},
	'/dashboard/preferences/add-account': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Add mail account',
	},

	// Automations section
	'/dashboard/automations': {
		section: 'Automations',
		sectionHref: '/dashboard/automations',
	},
};
