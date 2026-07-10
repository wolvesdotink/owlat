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
		page: 'All Campaigns',
	},
	'/dashboard/campaigns/all': {
		section: 'Campaigns',
		sectionHref: '/dashboard/campaigns',
		page: 'All Campaigns',
	},
	'/dashboard/campaigns/new': {
		section: 'Campaigns',
		sectionHref: '/dashboard/campaigns',
		page: 'New Campaign',
	},
	'/dashboard/campaigns/reports': {
		section: 'Campaigns',
		sectionHref: '/dashboard/campaigns',
		page: 'Reports',
	},
	'/dashboard/campaigns/ab-results': {
		section: 'Campaigns',
		sectionHref: '/dashboard/campaigns',
		page: 'A/B Results',
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

	// Settings section
	'/dashboard/settings': {
		section: 'Settings',
		sectionHref: '/dashboard/settings',
		page: 'Overview',
	},
	'/dashboard/settings/organization': {
		section: 'Settings',
		sectionHref: '/dashboard/settings',
		subsection: 'Organization',
		subsectionHref: '/dashboard/settings/organization',
	},
	'/dashboard/delivery': {
		section: 'Delivery',
		sectionHref: '/dashboard/delivery',
		page: 'Health',
	},
	'/dashboard/delivery/setup': {
		section: 'Delivery',
		sectionHref: '/dashboard/delivery',
		page: 'Setup',
	},
	'/dashboard/delivery/config': {
		section: 'Delivery',
		sectionHref: '/dashboard/delivery',
		subsection: 'Setup',
		subsectionHref: '/dashboard/delivery/setup',
		page: 'Delivery provider',
	},
	'/dashboard/delivery/domains': {
		section: 'Delivery',
		sectionHref: '/dashboard/delivery',
		subsection: 'Setup',
		subsectionHref: '/dashboard/delivery/setup',
		page: 'Sending Domains',
	},
	'/dashboard/delivery/provider-routing': {
		section: 'Delivery',
		sectionHref: '/dashboard/delivery',
		subsection: 'Setup',
		subsectionHref: '/dashboard/delivery/setup',
		page: 'Provider Routing',
	},
	'/dashboard/delivery/webhooks': {
		section: 'Delivery',
		sectionHref: '/dashboard/delivery',
		subsection: 'Setup',
		subsectionHref: '/dashboard/delivery/setup',
		page: 'Webhooks',
	},
	'/dashboard/settings/team': {
		section: 'Settings',
		sectionHref: '/dashboard/settings',
		subsection: 'Organization',
		subsectionHref: '/dashboard/settings/organization',
		page: 'Team Members',
	},
	'/dashboard/settings/email-theme': {
		section: 'Settings',
		sectionHref: '/dashboard/settings',
		subsection: 'Organization',
		subsectionHref: '/dashboard/settings/organization',
		page: 'Email Theme',
	},
	'/dashboard/settings/api': {
		section: 'Settings',
		sectionHref: '/dashboard/settings',
		page: 'API Keys',
	},
	'/dashboard/settings/forms': {
		section: 'Settings',
		sectionHref: '/dashboard/settings',
		page: 'Form Endpoints',
	},
	'/dashboard/settings/audit': {
		section: 'Settings',
		sectionHref: '/dashboard/settings',
		page: 'Audit Log',
	},
	'/dashboard/settings/account': {
		section: 'Settings',
		sectionHref: '/dashboard/settings',
		page: 'Account',
	},
	'/dashboard/settings/properties': {
		section: 'Settings',
		sectionHref: '/dashboard/settings',
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
			subsection: 'Reports',
			subsectionHref: '/dashboard/campaigns/reports',
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
								.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
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
