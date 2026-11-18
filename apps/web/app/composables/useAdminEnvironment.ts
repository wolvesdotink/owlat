import { api } from '@owlat/api';
import type { Ref } from 'vue';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import type { AdminEnvironment } from '~/lib/adminSettingsRegistry';

/**
 * The ambient inputs the admin registry's gates read (`AdminEnvironment`),
 * resolved once for every surface that projects the registry: the Settings
 * rail, the admin overview and the app-wide ⌘K palette. Two surfaces building
 * it separately could disagree about whether a page exists.
 *
 * `enabled` keeps a member's session from subscribing to admin reads at all.
 * While a read is loading its bit reads false, so a gated row appears once the
 * answer arrives rather than flashing in and back out.
 */
export function useAdminEnvironment(enabled: Readonly<Ref<boolean>>) {
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();

	// Deployment-level tooling is scoped to this deployment's platform admin —
	// the same gate the three pages carry as `platform-admin` route middleware.
	const { data: isPlatformAdmin } = useConvexQuery(
		api.platformAdmin.platformAdmin.isPlatformAdmin,
		() => (enabled.value ? {} : 'skip')
	);

	// Whether Email delivery lists the ramp's Advanced pages at all.
	const { data: hasRampStarted } = useConvexQuery(
		api.delivery.rampControlQueries.hasRampStarted,
		() => (enabled.value ? {} : 'skip')
	);

	// Settings left behind by a plugin removed from the build keep the Plugins
	// page listed, because that page is the only place to purge them. A build
	// that bundles plugins lists the page anyway, so it skips the read.
	const { data: pluginSettingsOverview } = useConvexQuery(
		api.plugins.settings.getPluginSettingsOverview,
		() => (enabled.value && bundledPluginComposition.length === 0 ? {} : 'skip')
	);

	const environment = computed<AdminEnvironment>(() => ({
		isFeatureEnabled,
		isPlatformAdmin: isPlatformAdmin.value === true,
		hasPlugins:
			bundledPluginComposition.length > 0 ||
			(pluginSettingsOverview.value?.orphaned.length ?? 0) > 0,
		hasRampStarted: hasRampStarted.value === true,
	}));

	return { environment };
}
