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
 */

import { api } from '@owlat/api';
import { computed, effectScope } from 'vue';
import {
	getDefaultFlags,
	resolveFlags,
	type FeatureFlagKey,
	type FeatureFlagState,
} from '@owlat/shared/featureFlags';

let inflight: ReturnType<
	typeof useConvexQuery<typeof api.workspaces.featureFlags.getFeatureFlags>
> | null = null;

export function useFeatureFlag() {
	// Single shared subscription for the whole app. Own it in a DETACHED
	// effect scope so the first caller's component/middleware scope can't tear
	// it down via onScopeDispose — which would freeze the singleton's data ref
	// for every other consumer once that first scope disposed.
	if (!inflight) {
		const scope = effectScope(true);
		scope.run(() => {
			inflight = useConvexQuery(api.workspaces.featureFlags.getFeatureFlags, {});
		});
	}

	const ssrFallback = useState<FeatureFlagState>('featureFlags', () => getDefaultFlags());

	const flags = computed<Record<FeatureFlagKey, boolean>>(() => {
		const live = inflight?.data.value;
		if (live) return live as Record<FeatureFlagKey, boolean>;
		return resolveFlags(ssrFallback.value);
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
