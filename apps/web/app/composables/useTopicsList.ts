import { api } from '@owlat/api';
import { useLoadAllPages } from './useLoadAllPages';

/**
 * Shared subscription to the organization's topics — the source of truth for
 * topic pickers and dropdowns across the app (campaign audience, form settings,
 * automation triggers, the segment filter builder, a contact's topics).
 *
 * Every page is loaded (`useLoadAllPages`, 100 at a time), the same as the
 * topics list page: a picker that stopped at the first page could not offer a
 * topic the list page shows.
 *
 * Usage: `const { results: topics } = useTopicsList()`.
 */
export function useTopicsList() {
	return useLoadAllPages(
		usePaginatedQuery(api.topics.topics.list, () => ({}), { initialNumItems: 100 }),
		100
	);
}
