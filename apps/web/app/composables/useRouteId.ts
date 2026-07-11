import type { ComputedRef } from 'vue';
import type { Id, TableNames } from '@owlat/api/dataModel';

/**
 * Narrow a single route param to a branded Convex `Id<T>` in one audited place.
 *
 * vue-router types `route.params[name]` as `string | string[] | undefined`
 * (undefined under `noUncheckedIndexedAccess`; an array for repeated or
 * catch-all segments). This centralises the unchecked cast the pages used to
 * repeat inline:
 *   - an array param narrows to its first element,
 *   - a missing/empty param narrows to an empty string (matching the previous
 *     `route.params['id'] as Id<T>` behaviour, where a missing param simply
 *     produced an unusable id and the page's query returned nothing).
 *
 * The result is a `ComputedRef` so pages stay reactive when only the param
 * changes (navigating between sibling detail routes without a remount).
 */
export function useRouteId<T extends TableNames>(param = 'id'): ComputedRef<Id<T>> {
	const route = useRoute();
	return computed(() => {
		const value = route.params[param];
		const id = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
		return id as Id<T>;
	});
}
