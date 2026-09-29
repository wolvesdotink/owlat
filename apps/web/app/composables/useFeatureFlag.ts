/**
 * Reactive feature flag access for components and middleware.
 *
 * Subscribes to the singleton featureFlags map via Convex and
 * resolves dependency cascades client-side. Use `isEnabled(flag)` to gate UI,
 * or destructure `flags` for a snapshot.
 *
 * Server-side rendering: reads `useState('featureFlags')` if present (set by the
 * Nuxt plugin during SSR); otherwise falls back to defaults so SSR markup matches
 * the eventual client state without a DB round-trip per request.
 *
 * Until the subscription answers, the fallback is seeded from the flags this
 * browser last saw on the same deployment (`lib/featureFlagCache.ts`), so the
 * nav and flag-gated queries start from the last session's state instead of the
 * all-off defaults. The live value always wins, and every live value is written
 * back. `isLoading` still reports the subscription, so guards that must not act
 * on a guess (the feature route middleware) keep waiting for it.
 */

import { api } from '@owlat/api';
import { computed, effectScope, shallowRef, watch } from 'vue';
import {
	getDefaultFlags,
	resolveFlags,
	type FeatureFlagKey,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';
import {
	readCachedFeatureFlags,
	writeCachedFeatureFlags,
	type CachedFlagMap,
} from '~/lib/featureFlagCache';
import { getActiveWorkspace, isDesktopRuntime } from '~/lib/desktop/activeWorkspace';

let inflight: ReturnType<
	typeof useConvexQuery<typeof api.workspaces.featureFlags.getFeatureFlags>
> | null = null;

/** Last-known flags for this deployment, read once when the subscription opens. */
const cachedSeed = shallowRef<CachedFlagMap | null>(null);

/**
 * The deployment the flags belong to. Desktop builds take it from the active
 * workspace (one deployment per workspace); the web build has exactly one.
 */
function flagCacheScope(): string | null {
	if (isDesktopRuntime()) return getActiveWorkspace()?.convexUrl || null;
	const url = useRuntimeConfig().public.convexUrl;
	return typeof url === 'string' && url ? url : null;
}

export function useFeatureFlag() {
	// Single shared subscription for the whole app. Own it in a DETACHED
	// effect scope so the first caller's component/middleware scope can't tear
	// it down via onScopeDispose — which would freeze the singleton's data ref
	// for every other consumer once that first scope disposed.
	if (!inflight) {
		const cacheScope = flagCacheScope();
		cachedSeed.value = readCachedFeatureFlags(cacheScope);
		const scope = effectScope(true);
		scope.run(() => {
			const query = useConvexQuery(api.workspaces.featureFlags.getFeatureFlags, {});
			inflight = query;
			watch(
				() => query.data.value,
				(live) => {
					if (live) writeCachedFeatureFlags(cacheScope, live as Record<string, boolean>);
				},
				{ immediate: true }
			);
		});
	}

	const ssrFallback = useState<FeatureFlagState>('featureFlags', () => getDefaultFlags());

	const flags = computed<Record<FeatureFlagKey, boolean>>(() => {
		const live = inflight?.data.value;
		if (live) return live as Record<FeatureFlagKey, boolean>;
		const defaults = resolveFlags(ssrFallback.value);
		// The cached map is a resolved server map, so its cascade already holds;
		// defaults only fill in flags added since it was written.
		if (!cachedSeed.value) return defaults;
		return { ...defaults, ...cachedSeed.value } as Record<FeatureFlagKey, boolean>;
	});

	function isEnabled(flag: FeatureFlagKey): boolean {
		return flags.value[flag] === true;
	}

	return {
		flags,
		isEnabled,
		isLoading: computed(() => inflight?.isLoading.value ?? false),
		error: computed(() => inflight?.error.value ?? null),
	};
}
