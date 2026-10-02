import { computed } from 'vue';
import { api } from '@owlat/api';
import { buildTransportOptions } from '~/utils/providerRouting';

/**
 * The two reads the provider-routing page is built on: the stored routes and
 * the transport catalog, plus what the page derives from them.
 *
 * The route cards and the editor are only true to what is stored once both
 * have answered. A failed `listRoutes` makes every message type look unrouted,
 * and Edit then seeds a fresh single-provider route that `setRoute` writes over
 * the stored strategy, IP pool and fallback; a failed catalog marks every
 * provider unavailable. `ready` is false while either read is pending or has
 * failed, and the page blocks Edit and Reset on it.
 */
export function useProviderRoutingReads() {
	const {
		data: routes,
		isLoading: routesLoading,
		error: routesError,
		refetch: refetchRoutes,
	} = useOrganizationQuery(api.providerRoutes.listRoutes);
	const {
		data: catalog,
		isLoading: catalogLoading,
		error: catalogError,
		refetch: refetchCatalog,
	} = useOrganizationQuery(api.providerRoutes.listTransportCatalog);

	const error = computed(() => routesError.value ?? catalogError.value ?? null);
	const ready = computed(
		() => error.value === null && routes.value !== undefined && catalog.value !== undefined
	);

	/** Re-read whichever of the two failed. */
	function retry() {
		if (routesError.value) refetchRoutes();
		if (catalogError.value) refetchCatalog();
	}

	const routeByType = computed(
		() => new Map((routes.value ?? []).map((route) => [route.messageType, route] as const))
	);

	const transportOptions = computed(() =>
		buildTransportOptions(
			catalog.value ?? [],
			(routes.value ?? []).flatMap((route) => route.providers)
		)
	);

	return {
		routes,
		isLoading: computed(() => routesLoading.value || catalogLoading.value),
		error,
		ready,
		retry,
		refetchCatalog,
		routeByType,
		transportOptions,
	};
}
