/**
 * Composable for generating breadcrumb navigation based on current route.
 * Maps the new navigation structure to breadcrumb trails.
 * Supports dynamic breadcrumb overrides for pages that need to show fetched data.
 */
export interface BreadcrumbItem {
	label: string;
	href?: string;
}

// Route configuration mapping paths to breadcrumb structure
interface RouteConfig {
	section: string;
	sectionHref: string;
	subsection?: string;
	subsectionHref?: string;
	page?: string;
}

// Shared state for dynamic breadcrumb overrides
const dynamicBreadcrumbState = ref<BreadcrumbItem[] | null>(null);

// Define route configurations for the new navigation structure
const routeConfigs: Record<string, RouteConfig> = {
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
	'/dashboard/admin/delivery': {
		section: 'Delivery',
		sectionHref: '/dashboard/admin/delivery',
		page: 'Health',
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
		page: 'API Keys',
	},
	'/dashboard/admin/team/senders': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Campaign senders',
	},
	'/dashboard/admin/team/inboxes': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Team Inboxes',
	},
	'/dashboard/admin/instance/forms': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Form Endpoints',
	},
	'/dashboard/admin/team/audit': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Audit Log',
	},
	'/dashboard/preferences/account': {
		section: 'Preferences',
		sectionHref: '/dashboard/preferences',
		page: 'Account',
	},
	'/dashboard/admin/instance/properties': {
		section: 'Administration',
		sectionHref: '/dashboard/admin',
		page: 'Contact Properties',
	},

	// Automations section
	'/dashboard/automations': {
		section: 'Automations',
		sectionHref: '/dashboard/automations',
	},
};

// Pattern configs for dynamic routes
interface PatternConfig {
	pattern: RegExp;
	getConfig: (match: RegExpMatchArray) => RouteConfig;
}

const patternConfigs: PatternConfig[] = [
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
];

export function useBreadcrumbs() {
	const route = useRoute();

	const breadcrumbs = computed<BreadcrumbItem[]>(() => {
		// If dynamic breadcrumbs are set, use them
		if (dynamicBreadcrumbState.value) {
			return dynamicBreadcrumbState.value;
		}

		const path = route.path;
		const items: BreadcrumbItem[] = [];

		// Check for exact match first
		let config = routeConfigs[path];

		// If no exact match, try pattern matching
		if (!config) {
			for (const patternConfig of patternConfigs) {
				const match = path.match(patternConfig.pattern);
				if (match) {
					config = patternConfig.getConfig(match);
					break;
				}
			}
		}

		// If still no config, generate a basic fallback
		if (!config) {
			// Generate breadcrumb from path segments
			const segments = path.split('/').filter(Boolean);
			if (segments.length > 0 && segments[0] === 'dashboard') {
				items.push({ label: 'Dashboard', href: '/dashboard' });
				for (let i = 1; i < segments.length; i++) {
					const segment = segments[i];
					// Skip IDs (assuming IDs are long strings or contain numbers)
					if (segment && segment.length > 20) continue;
					const label = segment
						? segment
								.split('-')
								.map((word) => capitalize(word))
								.join(' ')
						: '';
					items.push({ label });
				}
			}
			return items;
		}

		// Build breadcrumbs from config
		// Section is always first (and clickable unless it's the current page)
		const isOnSection = path === config.sectionHref && !config.subsection && !config.page;

		items.push({
			label: config.section,
			href: isOnSection ? undefined : config.sectionHref,
		});

		// Add subsection if present
		if (config.subsection && config.subsectionHref) {
			const isOnSubsection = path === config.subsectionHref && !config.page;
			items.push({
				label: config.subsection,
				href: isOnSubsection ? undefined : config.subsectionHref,
			});
		}

		// Add page if present (never clickable, it's the current page)
		if (config.page) {
			items.push({ label: config.page });
		}

		return items;
	});

	/**
	 * Set dynamic breadcrumbs for the current page.
	 * Call with null to clear and use route-based breadcrumbs.
	 */
	const setDynamicBreadcrumbs = (items: BreadcrumbItem[] | null) => {
		dynamicBreadcrumbState.value = items;
	};

	/**
	 * Clear dynamic breadcrumbs when component unmounts
	 */
	const clearDynamicBreadcrumbs = () => {
		dynamicBreadcrumbState.value = null;
	};

	return {
		breadcrumbs,
		setDynamicBreadcrumbs,
		clearDynamicBreadcrumbs,
	};
}
