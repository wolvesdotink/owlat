/**
 * Flag → docker-profile drift tracking (plan D4: apply is explicit, never
 * automatic). Toggling a flag in the admin UI only persists it in Convex;
 * when the toggle changes the derived docker-profile set, the affected
 * background services keep their old state until an explicit Apply converges
 * `.env`'s COMPOSE_PROFILES, the compose override and the CLI flag mirror via
 * the updater sidecar. This composable accumulates that drift and drives the
 * persistent "Services out of sync — Apply & restart" banner.
 */
import { ref } from 'vue';
import {
	getActiveProfiles,
	type FeatureFlagRegistry,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';

export interface ProfileServiceResult {
	service?: string;
	state?: string;
	status?: string;
	health?: string;
}

interface ApplyProfilesResponse {
	success?: boolean;
	profiles?: string[];
	services?: ProfileServiceResult[] | string;
}

// Module-scoped singletons (the app is ssr:false, so this is per-browser-tab
// state) shared across surfaces — drift noticed on the features page stays
// visible on the migration-mode card and vice versa until applied.
const pendingServices = ref<string[]>([]);
const isApplying = ref(false);
const serviceResults = ref<ProfileServiceResult[] | null>(null);
const applyError = ref<string | null>(null);

export function useProfileSync() {
	const { t } = useI18n();

	/**
	 * Record a committed flag change. A non-empty symmetric difference between
	 * the derived profile sets means services must start or stop; those names
	 * accumulate until the next successful Apply. The env-driven
	 * `deliveryProvider → mta` rule affects both sides of the diff equally, so
	 * the comparison is correct without reading `.env` from the browser.
	 */
	function trackFlagChange(
		before: FeatureFlagState,
		after: FeatureFlagState,
		registry?: FeatureFlagRegistry
	) {
		const opts = registry ? { registry } : {};
		const beforeProfiles = getActiveProfiles(before, opts);
		const afterProfiles = getActiveProfiles(after, opts);
		const beforeSet = new Set(beforeProfiles);
		const afterSet = new Set(afterProfiles);
		const changed = [
			...beforeProfiles.filter((profile) => !afterSet.has(profile)),
			...afterProfiles.filter((profile) => !beforeSet.has(profile)),
		];
		if (changed.length === 0) return;
		pendingServices.value = [...new Set([...pendingServices.value, ...changed])].sort();
		serviceResults.value = null;
	}

	/**
	 * POST the resolved flag snapshot to the session-authed Nuxt proxy route.
	 * On success the updater has already run `compose up -d`, so the pending set
	 * clears and the per-service results render. On failure the banner persists
	 * with the CLI fallback instructions.
	 */
	async function apply(flags: Record<string, boolean>) {
		if (isApplying.value) return;
		isApplying.value = true;
		applyError.value = null;
		try {
			const resp = await $fetch<ApplyProfilesResponse>('/api/system/apply-profiles', {
				method: 'POST',
				body: { flags },
				retry: 0,
				// `compose up -d` recreates only changed services, but a cold image
				// pull can still take minutes.
				timeout: 5 * 60 * 1000,
			});
			serviceResults.value = Array.isArray(resp.services) ? resp.services : [];
			pendingServices.value = [];
		} catch (err) {
			applyError.value =
				err instanceof Error ? err.message : t('shared.useProfileSync.updaterUnreachable');
		} finally {
			isApplying.value = false;
		}
	}

	function dismissResults() {
		serviceResults.value = null;
	}

	return {
		pendingServices,
		isApplying,
		serviceResults,
		applyError,
		trackFlagChange,
		apply,
		dismissResults,
	};
}
