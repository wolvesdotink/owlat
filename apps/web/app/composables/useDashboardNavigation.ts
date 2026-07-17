import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import {
	buildNavigationSections,
	derivePluginNavigation,
	type NavigationItem,
	type NavigationSection,
} from '~/lib/dashboardNavigation';

export type { NavigationItem, NavigationSection };

/**
 * Single source of truth for the dashboard sidebar destinations. Consumed by
 * both the sidebar (`layouts/dashboard.vue`) and the global command palette
 * (`AppCommandPalette`) so navigation never drifts between the two.
 *
 * Core destinations are declared once in `~/lib/dashboardNavigation` and
 * registered first through the host merge; plugin `navItems`/`settingsPanels`
 * from the statically composed bundled plugins are appended after every core
 * entry, gated behind each plugin's feature flag. The reactive shell just wires
 * the live feature flags and desktop context into the pure builder.
 */
export function useDashboardNavigation() {
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();
	const { isDesktop } = useDesktopContext();

	const navigationSections = computed<NavigationSection[]>(() =>
		buildNavigationSections(
			{ isFeatureEnabled, isDesktop: isDesktop.value },
			derivePluginNavigation(bundledPluginComposition, isFeatureEnabled)
		)
	);

	return { navigationSections };
}
