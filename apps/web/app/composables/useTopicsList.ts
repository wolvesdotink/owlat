import { api } from '@owlat/api';

/**
 * Shared subscription to the organization's topics list (paginated, first 100) —
 * the source of truth for topic pickers/dropdowns across the app.
 *
 * Usage: `const { results: topics } = useTopicsList()`.
 *
 * The topics management page (`audience/topics/index.vue`) owns its own
 * paginated list (with its own page size + loadMore) and does not use this.
 */
export function useTopicsList() {
	return usePaginatedQuery(api.topics.topics.list, () => ({}), { initialNumItems: 100 });
}
