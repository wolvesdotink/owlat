import { api } from '@owlat/api';
import type { Ref } from 'vue';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import {
	adminAreasFor,
	adminAttentionBadges,
	reachableAdminEntries,
	type AdminEnvironment,
} from '~/lib/adminSettingsRegistry';

/**
 * The Workspace half of the Settings sidebar, as both settings layouts need it:
 * the deployment's admin environment, the groups it can reach, and the
 * attention badges (held and failed incoming mail) the rail shows next to them.
 *
 * `enabled` keeps a member's session from subscribing to admin reads at all —
 * the preferences layout passes `isAdmin`, the admin layout (already
 * admin-gated) passes `true`.
 */
export function useWorkspaceSettingsNav(enabled: Readonly<Ref<boolean>>) {
	const { isEnabled: isFeatureEnabled } = useFeatureFlag();
	const config = useRuntimeConfig();

	// Deployment-level tooling is scoped to this deployment's platform admin —
	// the same gate the three pages carry as `platform-admin` route middleware.
	const { data: isPlatformAdmin } = useConvexQuery(
		api.platformAdmin.platformAdmin.isPlatformAdmin,
		() => (enabled.value ? {} : 'skip')
	);

	const environment = computed<AdminEnvironment>(() => ({
		isFeatureEnabled,
		isPlatformAdmin: isPlatformAdmin.value === true,
		hasPlugins: bundledPluginComposition.length > 0,
		isSelfHosted: config.public.deploymentMode === 'selfhost',
	}));

	const areas = computed(() => (enabled.value ? adminAreasFor(environment.value) : []));

	// The denormalized inbound counters: one cheap read, already subscribed to
	// by several dashboard cards.
	const { data: inboundStats } = useConvexQuery(api.inbox.queries.getInboundStats, () =>
		enabled.value && isFeatureEnabled('inbox') ? {} : 'skip'
	);
	const badges = computed(() => {
		const stats = inboundStats.value;
		if (!enabled.value || !stats || typeof stats !== 'object') return {};
		return adminAttentionBadges(reachableAdminEntries(environment.value), {
			quarantined: stats.quarantined,
			failed: stats.failed,
		});
	});

	return { environment, areas, badges };
}
