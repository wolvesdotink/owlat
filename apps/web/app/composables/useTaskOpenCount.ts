import { api } from '@owlat/api';

/** How many open tasks the viewer owns, for the navigation badge. */
export function useTaskOpenCount() {
	const { data } = useConvexQuery(api.tasks.tasks.openCount, {});
	return { count: computed(() => data.value ?? 0) };
}
