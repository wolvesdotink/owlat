/**
 * The All inboxes list: every readable Inbox merged newest first
 * (`mail.mailbox.allInboxes.listMessages`), paged through the same keyset
 * cursor feed as one folder, so the first page stays live and "Load more"
 * appends.
 *
 * The sources come from `mail.mailbox.queries.accessible` (the subscription
 * the shell already holds), which names each inbox's Inbox folder. The server
 * still checks every source against the caller's own mailboxes and team-inbox
 * memberships; the list here only decides which of them to ask for.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { allInboxesSources } from '~/utils/postboxAllInboxes';

export function usePostboxAllInboxesFeed(args: {
	/** One inbox to narrow to (`?in=`), or null for every inbox. */
	only: Ref<Id<'mailboxes'> | null>;
}) {
	const { data: accessible, isLoading: accessibleLoading } = useConvexQuery(
		api.mail.mailbox.queries.accessible,
		() => ({})
	);
	const sources = computed(() => allInboxesSources(accessible.value ?? [], args.only.value));
	// A different set of inboxes is a different list: no cursor carries over.
	const resetKey = computed(() => sources.value.map((source) => source.folderId).join(','));

	const feed = usePostboxCursorFeed(
		api.mail.mailbox.allInboxes.listMessages,
		() => (sources.value.length > 0 ? { sources: sources.value, limit: 50 } : 'skip'),
		resetKey,
		{ keepPreviousData: true }
	);

	return {
		messages: feed.rows,
		isLoading: computed(
			() => (accessibleLoading.value && !accessible.value) || feed.isLoading.value
		),
		isLoadingMore: feed.isLoadingMore,
		hasMore: feed.hasMore,
		canLoadMore: feed.canLoadMore,
		loadMore: feed.loadMore,
		/** The first page failed: a failed read, not an empty list. */
		error: feed.firstPageError,
		refetch: feed.refetch,
	};
}
