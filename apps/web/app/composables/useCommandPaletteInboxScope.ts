/**
 * Team Inbox scope for the command palette: live thread hits on
 * `/dashboard/inbox/**`.
 *
 * The route-aware overlay closed three of the app's four search boxes; this
 * closes the odd gap on the other side of it. The Team Inbox list page shipped
 * no text search at all, even though its threads were already being searched
 * from two pickers that filtered a fetched page in the browser. Now that
 * `inbox.queries.listThreads` takes a `search` argument
 * (`apps/api/convex/inbox/threadSearch.ts`), the overlay gets that corpus for
 * free wherever the Team Inbox is the thing you are looking at.
 *
 * This is a ROUTE-SCOPED contribution, not a new scope on the Tab cycle: the
 * threads join the Everything palette while you are in the Team Inbox and are
 * gone the moment you leave, which is what the registry's `matchRoute` seam is
 * for (`~/lib/commandPaletteCore` declares the provider).
 *
 * Like the Mail scope, every subscription is gated: the palette is mounted on
 * EVERY dashboard page, so this must cost nothing on the billing screen.
 */
import { api } from '@owlat/api';
import type { PaletteItem } from '~/lib/commandPalette';
import { SEARCH_MIN_QUERY } from '~/lib/commandPaletteCore';

/** How many thread hits the overlay shows. Matches the other object groups. */
const INBOX_SCOPE_HIT_LIMIT = 5;

/** Mirrors the Mail scope: how still the box has to be before we subscribe. */
const INBOX_SEARCH_DEBOUNCE_MS = 250;

export interface CommandPaletteInboxScopeOptions {
	/** The palette query, with any mode prefix already stripped. */
	query: Ref<string>;
	/** False whenever the Team Inbox is not the active surface: nothing subscribes. */
	enabled: Ref<boolean>;
	/** Remember the query that opened a hit (scope-tagged palette recents). */
	onRemember: (term: string) => void;
}

export function useCommandPaletteInboxScope(options: CommandPaletteInboxScopeOptions) {
	const { t } = useI18n();
	const { isEnabled: isFlagEnabled } = useFeatureFlag();

	const {
		query: pendingQuery,
		debouncedQuery,
		setImmediate,
	} = useDebouncedSearch(INBOX_SEARCH_DEBOUNCE_MS);
	watch(options.query, (value) => {
		pendingQuery.value = value;
	});

	/** Drop the previous query's hits the moment the overlay closes or reopens. */
	function resetQuery(value = '') {
		setImmediate(value);
	}

	const isSubscribed = computed(
		() =>
			options.enabled.value &&
			isFlagEnabled('inbox') &&
			debouncedQuery.value.trim().length >= SEARCH_MIN_QUERY
	);

	const { data } = useConvexQuery(api.inbox.queries.listThreads, () =>
		isSubscribed.value
			? { search: debouncedQuery.value.trim(), limit: INBOX_SCOPE_HIT_LIMIT }
			: 'skip'
	);

	/** True while the box is ahead of the subscription, or the page is in flight. */
	const isSearching = computed(
		() =>
			options.enabled.value &&
			isFlagEnabled('inbox') &&
			options.query.value.trim().length >= SEARCH_MIN_QUERY &&
			(options.query.value !== debouncedQuery.value || data.value === undefined)
	);

	const threadItems = computed<PaletteItem[]>(() =>
		(data.value?.threads ?? []).map((thread) => ({
			id: `inbox-thread:${thread._id}`,
			label: thread.subject?.trim() || t('components.appCommandPalette.noSubject'),
			subtitle: thread.contactIdentifier,
			icon: 'lucide:message-square',
			run: () => {
				options.onRemember(options.query.value);
				void navigateTo(`/dashboard/inbox/${thread._id}`);
			},
		}))
	);

	return { threadItems, isSearching, resetQuery };
}
