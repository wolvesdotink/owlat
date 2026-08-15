/**
 * Composable for generating breadcrumb navigation based on current route.
 * Maps the new navigation structure to breadcrumb trails.
 * Supports dynamic breadcrumb overrides for pages that need to show fetched data.
 */
import { patternConfigs } from '~/lib/breadcrumbPatterns';
import { routeConfigs, type RouteConfig } from '~/lib/breadcrumbRoutes';

export interface BreadcrumbItem {
	label: string;
	href?: string;
}

// Shared state for dynamic breadcrumb overrides
const dynamicBreadcrumbState = ref<BreadcrumbItem[] | null>(null);

/**
 * Members (role `editor`) see the Audience section as "Customers", landing on the
 * customer list rather than the admin-only overview — see the `isMemberAudience`
 * remap in `lib/dashboardNavigation.ts`. Breadcrumbs mirror it so the trail can't
 * disagree with the sidebar the viewer is looking at.
 */
const MEMBER_AUDIENCE_HREF = '/dashboard/audience/contacts';
/**
 * Both labels are message KEYS, not words: the trail is compared against the
 * SIDEBAR's own key (`shared.dashboardNavigation.sections.customers`), and
 * matching on the English sentence would silently stop remapping the moment the
 * copy was extracted — leaving a member on a trail that says "Audience" beside a
 * sidebar that says "Customers".
 */
const AUDIENCE_SECTION_KEY = 'shared.breadcrumbRoutes.sections.audience';
const MEMBER_AUDIENCE_SECTION_KEY = 'shared.dashboardNavigation.sections.customers';

function applyMemberAudienceLabel(config: RouteConfig, path: string): RouteConfig {
	if (config.section !== AUDIENCE_SECTION_KEY) return config;
	// On the customer list itself the section crumb *is* the page.
	if (path === MEMBER_AUDIENCE_HREF) {
		return { section: MEMBER_AUDIENCE_SECTION_KEY, sectionHref: MEMBER_AUDIENCE_HREF };
	}
	const { subsection, subsectionHref, ...rest } = config;
	// A "Contacts" subsection would repeat the (renamed) section destination.
	const keepSubsection = subsection !== undefined && subsectionHref !== MEMBER_AUDIENCE_HREF;
	return {
		...rest,
		section: MEMBER_AUDIENCE_SECTION_KEY,
		sectionHref: MEMBER_AUDIENCE_HREF,
		...(keepSubsection ? { subsection, subsectionHref } : {}),
	};
}

export function useBreadcrumbs() {
	const route = useRoute();
	const { role } = useOrganizationContext();

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

		// Role-aware section labels (keep the trail in step with the sidebar).
		if (role.value === 'editor') {
			config = applyMemberAudienceLabel(config, path);
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
